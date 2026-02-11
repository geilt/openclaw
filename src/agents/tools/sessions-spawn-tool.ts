import { Type } from "@sinclair/typebox";
import type { GatewayMessageChannel } from "../../utils/message-channel.js";
import type { AnyAgentTool } from "./common.js";
import { formatThinkingLevels, normalizeThinkLevel } from "../../auto-reply/thinking.js";
import { loadConfig } from "../../config/config.js";
import { callGateway } from "../../gateway/call.js";
import {
  isSubagentSessionKey,
  normalizeAgentId,
  parseAgentSessionKey,
} from "../../routing/session-key.js";
import { normalizeDeliveryContext } from "../../utils/delivery-context.js";
import { resolveAgentConfig } from "../agent-scope.js";
import {
  resolveContextScripts,
  executeContextScripts,
  type ContextScriptEntry,
} from "../context-scripts.js";
import { AGENT_LANE_SUBAGENT } from "../lanes.js";
import { optionalStringEnum } from "../schema/typebox.js";
import { spawnSubagentDirect } from "../subagent-spawn.js";
import { jsonResult, readStringParam } from "./common.js";

const SessionsSpawnToolSchema = Type.Object({
  task: Type.String(),
  label: Type.Optional(Type.String()),
  agentId: Type.Optional(Type.String()),
  model: Type.Optional(Type.String()),
  thinking: Type.Optional(Type.String()),
  runTimeoutSeconds: Type.Optional(Type.Number({ minimum: 0 })),
  // Back-compat: older callers used timeoutSeconds for this tool.
  timeoutSeconds: Type.Optional(Type.Number({ minimum: 0 })),
  cleanup: optionalStringEnum(["delete", "keep"] as const),
});

export function createSessionsSpawnTool(opts?: {
  agentSessionKey?: string;
  agentChannel?: GatewayMessageChannel;
  agentAccountId?: string;
  agentTo?: string;
  agentThreadId?: string | number;
  agentGroupId?: string | null;
  agentGroupChannel?: string | null;
  agentGroupSpace?: string | null;
  sandboxed?: boolean;
  /** Explicit agent ID override for cron/hook sessions where session key parsing may not work. */
  requesterAgentIdOverride?: string;
}): AnyAgentTool {
  return {
    label: "Sessions",
    name: "sessions_spawn",
    description:
      "Spawn a background sub-agent run in an isolated session and announce the result back to the requester chat.",
    parameters: SessionsSpawnToolSchema,
    execute: async (_toolCallId, args) => {
      const params = args as Record<string, unknown>;
      const task = readStringParam(params, "task", { required: true });
      const label = typeof params.label === "string" ? params.label.trim() : "";
      const requestedAgentId = readStringParam(params, "agentId");
      const modelOverride = readStringParam(params, "model");
      const thinkingOverrideRaw = readStringParam(params, "thinking");
      const cleanup =
        params.cleanup === "keep" || params.cleanup === "delete" ? params.cleanup : "keep";
      // Back-compat: older callers used timeoutSeconds for this tool.
      const timeoutSecondsCandidate =
        typeof params.runTimeoutSeconds === "number"
          ? params.runTimeoutSeconds
          : typeof params.timeoutSeconds === "number"
            ? params.timeoutSeconds
            : undefined;
      const runTimeoutSeconds =
        typeof timeoutSecondsCandidate === "number" && Number.isFinite(timeoutSecondsCandidate)
          ? Math.max(0, Math.floor(timeoutSecondsCandidate))
          : undefined;

      const result = await spawnSubagentDirect(
        {
          task,
          label: label || undefined,
          agentId: requestedAgentId,
          model: modelOverride,
          thinking: thinkingOverrideRaw,
          runTimeoutSeconds,
          cleanup,
          expectsCompletionMessage: true,
        },
        {
          agentSessionKey: opts?.agentSessionKey,
          agentChannel: opts?.agentChannel,
          agentAccountId: opts?.agentAccountId,
          agentTo: opts?.agentTo,
          agentThreadId: opts?.agentThreadId,
          agentGroupId: opts?.agentGroupId,
          agentGroupChannel: opts?.agentGroupChannel,
          agentGroupSpace: opts?.agentGroupSpace,
          requesterAgentIdOverride: opts?.requesterAgentIdOverride,
        },
      );
      let initialTargetAgentId = requestedAgentId
        ? normalizeAgentId(requestedAgentId)
        : requesterAgentId;

      // --- Context Scripts: resolve and execute BEFORE auth/config resolution ---
      // This allows scripts to override the targetAgentId (e.g. dalta → patron)
      let resolvedTask = task;
      {
        const defaultSubagents = cfg.agents?.defaults?.subagents as
          | (Record<string, unknown> & { contextScripts?: { run?: ContextScriptEntry[] } })
          | undefined;
        const defaultContextScripts: ContextScriptEntry[] =
          defaultSubagents?.contextScripts?.run ?? [];
        // For agent-specific scripts, try the initial target first, fall back to requester
        const initialTargetConfig = resolveAgentConfig(cfg, initialTargetAgentId);
        const agentSubagents = (initialTargetConfig ?? resolveAgentConfig(cfg, requesterAgentId))
          ?.subagents as
          | (Record<string, unknown> & {
              contextScripts?: { run?: ContextScriptEntry[]; ignore?: string[] };
            })
          | undefined;
        const agentContextScripts: ContextScriptEntry[] = agentSubagents?.contextScripts?.run ?? [];
        const agentIgnoreScripts: string[] = agentSubagents?.contextScripts?.ignore ?? [];

        if (defaultContextScripts.length > 0 || agentContextScripts.length > 0) {
          try {
            const scripts = resolveContextScripts(
              defaultContextScripts,
              agentContextScripts,
              agentIgnoreScripts,
            );
            if (scripts.length > 0) {
              const spawnVariables: Record<string, unknown> = {
                targetAgentId: initialTargetAgentId,
                task,
                label,
                requesterAgentId,
                requesterSessionKey,
                cleanup,
                cfg,
              };
              const { prepend, append, agentIdOverride } = await executeContextScripts(
                scripts,
                spawnVariables,
                (candidateId) => resolveAgentConfig(cfg, normalizeAgentId(candidateId)) != null,
              );
              if (prepend || append) {
                resolvedTask = [prepend, task, append].filter(Boolean).join("\n\n");
              }
              if (agentIdOverride) {
                initialTargetAgentId = normalizeAgentId(agentIdOverride);
              }
            }
          } catch (err) {
            console.warn(
              `[context-scripts] Error running context scripts: ${err instanceof Error ? err.message : String(err)}`,
            );
          }
        }
      }
      // --- End Context Scripts ---

      // Now resolve with potentially overridden targetAgentId
      const targetAgentId = initialTargetAgentId;
      if (targetAgentId !== requesterAgentId) {
        const allowAgents = resolveAgentConfig(cfg, requesterAgentId)?.subagents?.allowAgents ?? [];
        const allowAny = allowAgents.some((value) => value.trim() === "*");
        const normalizedTargetId = targetAgentId.toLowerCase();
        const allowSet = new Set(
          allowAgents
            .filter((value) => value.trim() && value.trim() !== "*")
            .map((value) => normalizeAgentId(value).toLowerCase()),
        );
        if (!allowAny && !allowSet.has(normalizedTargetId)) {
          const allowedText = allowAny
            ? "*"
            : allowSet.size > 0
              ? Array.from(allowSet).join(", ")
              : "none";
          return jsonResult({
            status: "forbidden",
            error: `agentId is not allowed for sessions_spawn (allowed: ${allowedText})`,
          });
        }
      }
      const childSessionKey = `agent:${targetAgentId}:subagent:${crypto.randomUUID()}`;
      const spawnedByKey = requesterInternalKey;
      const targetAgentConfig = resolveAgentConfig(cfg, targetAgentId);
      const resolvedModel =
        normalizeModelSelection(modelOverride) ??
        normalizeModelSelection(targetAgentConfig?.subagents?.model) ??
        normalizeModelSelection(cfg.agents?.defaults?.subagents?.model);

      const resolvedThinkingDefaultRaw =
        readStringParam(targetAgentConfig?.subagents ?? {}, "thinking") ??
        readStringParam(cfg.agents?.defaults?.subagents ?? {}, "thinking");

      let thinkingOverride: string | undefined;
      const thinkingCandidateRaw = thinkingOverrideRaw || resolvedThinkingDefaultRaw;
      if (thinkingCandidateRaw) {
        const normalized = normalizeThinkLevel(thinkingCandidateRaw);
        if (!normalized) {
          const { provider, model } = splitModelRef(resolvedModel);
          const hint = formatThinkingLevels(provider, model);
          return jsonResult({
            status: "error",
            error: `Invalid thinking level "${thinkingCandidateRaw}". Use one of: ${hint}.`,
          });
        }
        thinkingOverride = normalized;
      }
      if (resolvedModel) {
        try {
          await callGateway({
            method: "sessions.patch",
            params: { key: childSessionKey, model: resolvedModel },
            timeoutMs: 10_000,
          });
          modelApplied = true;
        } catch (err) {
          const messageText =
            err instanceof Error ? err.message : typeof err === "string" ? err : "error";
          const recoverable =
            messageText.includes("invalid model") || messageText.includes("model not allowed");
          if (!recoverable) {
            return jsonResult({
              status: "error",
              error: messageText,
              childSessionKey,
            });
          }
          modelWarning = messageText;
        }
      }
      if (thinkingOverride !== undefined) {
        try {
          await callGateway({
            method: "sessions.patch",
            params: {
              key: childSessionKey,
              thinkingLevel: thinkingOverride === "off" ? null : thinkingOverride,
            },
            timeoutMs: 10_000,
          });
        } catch (err) {
          const messageText =
            err instanceof Error ? err.message : typeof err === "string" ? err : "error";
          return jsonResult({
            status: "error",
            error: messageText,
            childSessionKey,
          });
        }
      }

      const childSystemPrompt = buildSubagentSystemPrompt({
        requesterSessionKey,
        requesterOrigin,
        childSessionKey,
        label: label || undefined,
        task: resolvedTask,
      });

      const childIdem = crypto.randomUUID();
      let childRunId: string = childIdem;
      try {
        const response = await callGateway<{ runId: string }>({
          method: "agent",
          params: {
            message: resolvedTask,
            sessionKey: childSessionKey,
            channel: requesterOrigin?.channel,
            to: requesterOrigin?.to ?? undefined,
            accountId: requesterOrigin?.accountId ?? undefined,
            threadId:
              requesterOrigin?.threadId != null ? String(requesterOrigin.threadId) : undefined,
            idempotencyKey: childIdem,
            deliver: false,
            lane: AGENT_LANE_SUBAGENT,
            extraSystemPrompt: childSystemPrompt,
            thinking: thinkingOverride,
            timeout: runTimeoutSeconds > 0 ? runTimeoutSeconds : undefined,
            label: label || undefined,
            spawnedBy: spawnedByKey,
            groupId: opts?.agentGroupId ?? undefined,
            groupChannel: opts?.agentGroupChannel ?? undefined,
            groupSpace: opts?.agentGroupSpace ?? undefined,
          },
          timeoutMs: 10_000,
        });
        if (typeof response?.runId === "string" && response.runId) {
          childRunId = response.runId;
        }
      } catch (err) {
        const messageText =
          err instanceof Error ? err.message : typeof err === "string" ? err : "error";
        return jsonResult({
          status: "error",
          error: messageText,
          childSessionKey,
          runId: childRunId,
        });
      }

      registerSubagentRun({
        runId: childRunId,
        childSessionKey,
        requesterSessionKey: requesterInternalKey,
        requesterOrigin,
        requesterDisplayKey,
        task,
        cleanup,
        label: label || undefined,
        runTimeoutSeconds,
      });

      return jsonResult({
        status: "accepted",
        childSessionKey,
        runId: childRunId,
        modelApplied: resolvedModel ? modelApplied : undefined,
        warning: modelWarning,
      });
    },
  };
}

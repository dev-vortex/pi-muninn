/**
 * File intent: project-curation wrappers for memory_graph and memory_tunnel.
 *
 * In project-curation mode the vendored graph/tunnel tool names are mapped to
 * user/topic relationships across project-user memory databases.
 */

import path from "node:path";

import {
  loadProjectMemoryConfig,
  resolveProjectMemoryDirectory,
} from "../../project-memory/config.js";
import { resolveContextCwd } from "./environment.js";
import { readMemoryTunnelPayloadContract } from "./payload-contracts.js";
import {
  readProjectUserDatabasePaths,
  readUserIdFromDatabasePath,
  readUserMemoryCount,
  readUserMemoryRows,
  readUserTopicCounts,
} from "./sqlite-read-models.js";
import { buildTextToolResult } from "./text-tool-result.js";

export const buildProjectUserMemoryGraph = async (projectRoot: string): Promise<{
  nodes: Array<{
    userId: string;
    memoryCount: number;
    topics: string[];
  }>;
  edges: Array<{
    userA: string;
    userB: string;
    topic: string;
    strength: number;
  }>;
}> => {
  const databasePaths = await readProjectUserDatabasePaths(projectRoot);
  const nodes: Array<{
    userId: string;
    memoryCount: number;
    topics: string[];
  }> = [];

  const topicUserCounts = new Map<string, Map<string, number>>();

  for (const databasePath of databasePaths) {
    const userId = readUserIdFromDatabasePath(databasePath);
    const topicCounts = readUserTopicCounts(databasePath);
    const memoryCount = readUserMemoryCount(databasePath);

    nodes.push({
      userId,
      memoryCount,
      topics: topicCounts.map((row) => row.topic),
    });

    for (const row of topicCounts) {
      const countsByUser = topicUserCounts.get(row.topic) || new Map<string, number>();
      countsByUser.set(userId, row.count);
      topicUserCounts.set(row.topic, countsByUser);
    }
  }

  const edges: Array<{
    userA: string;
    userB: string;
    topic: string;
    strength: number;
  }> = [];

  for (const [topic, countsByUser] of topicUserCounts.entries()) {
    const userCounts = [...countsByUser.entries()];

    for (let left = 0; left < userCounts.length; left += 1) {
      for (let right = left + 1; right < userCounts.length; right += 1) {
        const [userA, countA] = userCounts[left];
        const [userB, countB] = userCounts[right];

        edges.push({
          userA,
          userB,
          topic,
          strength: Math.min(countA, countB),
        });
      }
    }
  }

  return { nodes, edges };
};

/**
 * Execute memory_graph in project-curation mode as user-topic graph.
 */
export const executeProjectAwareMemoryGraph = async (input: {
  ctx: unknown;
}): Promise<unknown> => {
  const projectRoot = resolveContextCwd(input.ctx);

  let graph: Awaited<ReturnType<typeof buildProjectUserMemoryGraph>>;

  try {
    const config = await loadProjectMemoryConfig(projectRoot);
    if (!config.projectMemoryEnabled) {
      return buildTextToolResult({
        text: "Project user graph is unavailable while project memory is disabled.",
        details: {
          status: "project-memory-disabled",
          route: "memory_graph_project_users",
        },
      });
    }

    graph = await buildProjectUserMemoryGraph(projectRoot);
  } catch (error: unknown) {
    return buildTextToolResult({
      text: `Project user graph failed: ${error instanceof Error ? error.message : String(error)}`,
      details: {
        status: "error",
        route: "memory_graph_project_users",
      },
    });
  }

  if (graph.nodes.length === 0) {
    return buildTextToolResult({
      text: "No project-user memories available yet.",
      details: {
        status: "empty",
        route: "memory_graph_project_users",
      },
    });
  }

  let text = "## Project Memory Graph (Users)\n\n";
  text += "### Users\n";

  for (const node of graph.nodes.sort((a, b) => b.memoryCount - a.memoryCount)) {
    const topicsText = node.topics.length > 0
      ? ` — topics: ${node.topics.join(", ")}`
      : "";
    text += `- **${node.userId}** (${node.memoryCount} memories)${topicsText}\n`;
  }

  if (graph.edges.length > 0) {
    text += "\n### Shared-topic links\n";

    for (const edge of graph.edges.sort((a, b) => b.strength - a.strength)) {
      text += `- ${edge.userA} ↔ ${edge.userB} via topic "${edge.topic}" (${edge.strength} shared)\n`;
    }
  } else {
    text += "\nNo shared-topic links between users yet.\n";
  }

  return buildTextToolResult({
    text: text.trimEnd(),
    details: {
      status: "ok",
      route: "memory_graph_project_users",
      nodeCount: graph.nodes.length,
      edgeCount: graph.edges.length,
    },
  });
};

/**
 * Execute memory_tunnel in project-curation mode as user-topic tunnel.
 */
export const executeProjectAwareMemoryTunnel = async (input: {
  toolInput: unknown;
  ctx: unknown;
}): Promise<unknown> => {
  const payload = readMemoryTunnelPayloadContract(input.toolInput);

  if (!payload.topic || !payload.userA || !payload.userB) {
    return buildTextToolResult({
      text: "memory_tunnel in project mode requires topic, project_a(user_a), and project_b(user_b).",
      details: {
        status: "invalid-arguments",
        route: "memory_tunnel_project_users",
      },
    });
  }

  const projectRoot = resolveContextCwd(input.ctx);

  try {
    const config = await loadProjectMemoryConfig(projectRoot);
    if (!config.projectMemoryEnabled) {
      return buildTextToolResult({
        text: "Project user tunnel is unavailable while project memory is disabled.",
        details: {
          status: "project-memory-disabled",
          route: "memory_tunnel_project_users",
        },
      });
    }

    const projectMemoryDir = resolveProjectMemoryDirectory(projectRoot);
    const userADatabasePath = path.join(projectMemoryDir, `${payload.userA}.db`);
    const userBDatabasePath = path.join(projectMemoryDir, `${payload.userB}.db`);

    const userAHits = readUserMemoryRows({
      databasePath: userADatabasePath,
      topic: payload.topic,
      limit: payload.nResults,
    });
    const userBHits = readUserMemoryRows({
      databasePath: userBDatabasePath,
      topic: payload.topic,
      limit: payload.nResults,
    });

    const tunnelHits = [...userAHits, ...userBHits]
      .sort((left, right) => right.timestamp.localeCompare(left.timestamp))
      .slice(0, payload.nResults * 2);

    if (tunnelHits.length === 0) {
      return buildTextToolResult({
        text: `No memories found in tunnel: ${payload.userA} ↔ ${payload.userB} via "${payload.topic}"`,
        details: {
          status: "empty",
          route: "memory_tunnel_project_users",
          topic: payload.topic,
          userA: payload.userA,
          userB: payload.userB,
        },
      });
    }

    let text = `## Project Memory Tunnel: ${payload.userA} ↔ ${payload.userB} via "${payload.topic}"\n\n`;

    for (const hit of tunnelHits) {
      text += `[${hit.userId}/${hit.topic}] (${hit.timestamp})\n`;
      text += `${hit.content}\n\n---\n\n`;
    }

    return buildTextToolResult({
      text: text.trimEnd(),
      details: {
        status: "ok",
        route: "memory_tunnel_project_users",
        topic: payload.topic,
        userA: payload.userA,
        userB: payload.userB,
        count: tunnelHits.length,
      },
    });
  } catch (error: unknown) {
    return buildTextToolResult({
      text: `Project user tunnel failed: ${error instanceof Error ? error.message : String(error)}`,
      details: {
        status: "error",
        route: "memory_tunnel_project_users",
      },
    });
  }
};

/**
 * Execute internal memory_save_L3 route (general-target payload).
 *
 * Decision:
 * - route general payload into upstream memory_save write path,
 * - force global target project bucket for broad/high-recall L3 capture.
 */

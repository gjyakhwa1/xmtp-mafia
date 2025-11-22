import type { Agent } from "@xmtp/agent-sdk";
import {
  ContentTypeActions,
  type ActionsContent,
} from "../xmtp-inline-actions/types/index.js";
import { KILL_PHASE_DURATION_MS } from "../config/gameConfig.js";
import type { GameManager } from "../gameManager.js";
import { getPlayerAddress } from "./playerAddress.js";

/**
 * Send kill buttons for all alive players (except mafia) in DM
 */
export async function sendKillButtons(
  agent: Agent,
  dm: any,
  gameManager: GameManager,
  round: number,
  mafiaInboxId: string
): Promise<void> {
  try {
    const alivePlayers = gameManager.getAlivePlayers().filter(
      (p) => p.inboxId !== mafiaInboxId
    );

    if (alivePlayers.length === 0) {
      return;
    }

    // Get the lobby group to resolve addresses
    const lobbyId = gameManager.getGame().lobbyGroupId;
    const lobbyGroup = lobbyId
      ? await agent.client.conversations.getConversationById(lobbyId)
      : null;

    // Create buttons for each alive player
    const killActions = await Promise.all(
      alivePlayers.map(async (player) => {
        // Try to get player address for display
        const playerAddress = lobbyGroup
          ? await getPlayerAddress(agent, player.inboxId, lobbyGroup)
          : null;
        const displayName = playerAddress
          ? `${player.username} (${playerAddress.slice(0, 6)}...${playerAddress.slice(-4)})`
          : player.username;

        return {
          id: `kill-${player.inboxId}`,
          label: `🔪 ${displayName}`,
          style: "danger" as const,
        };
      })
    );

    const actionsContent: ActionsContent = {
      id: `kill-phase-${round}-${Date.now()}`,
      description: `🔪 Kill Phase - Select a target:\n\nClick a button below to attempt a kill.`,
      actions: killActions,
      expiresAt: new Date(Date.now() + KILL_PHASE_DURATION_MS).toISOString(),
    };

    // Send using underlying client
    const client = (agent as any).client;
    if (client && client.conversations) {
      const conv = await client.conversations.getConversationById(dm.id);
      if (conv) {
        await conv.send(actionsContent, ContentTypeActions);
      } else {
        throw new Error("Could not get conversation");
      }
    } else {
      throw new Error("Could not access client");
    }
  } catch (error) {
    console.error("Error sending kill buttons:", error);
    // Fallback: send text message with instructions
    const aliveUsernames = gameManager
      .getAlivePlayerUsernames()
      .filter((u) => {
        const player = gameManager.getAlivePlayers().find((p) => p.username === u);
        return player && player.inboxId !== mafiaInboxId;
      });
    await dm.send(
      `Round ${round} Kill Phase.\n\n` +
        `Try killing a player using:\n` +
        `kill <address> or kill <username>\n\n` +
        `Alive players: ${aliveUsernames.join(", ")}`
    );
  }
}


import { AgentMiddleware, filter } from "@xmtp/agent-sdk";
import type { Agent } from "@xmtp/agent-sdk";
import type { IntentContent } from "../xmtp-inline-actions/types/index.js";
import { isMentioned, parseCommand, isAgentInGroup } from "../utils/helpers.js";
import type { GameManager } from "../gameManager.js";
import { handleIntentMessage } from "../handlers/intentHandler.js";

export function createCommandMiddleware(
  agent: Agent,
  gameManager: GameManager
): AgentMiddleware {
  return async (ctx, next) => {
    // Log all incoming messages
    console.log("=".repeat(60));
    console.log("📨 Message received:");
    console.log(`   Sender: ${ctx.message.senderInboxId}`);
    console.log(`   Content: ${ctx.message.content}`);
    console.log(`   Conversation ID: ${ctx.conversation?.id || "N/A"}`);
    console.log(`   Is Text: ${filter.isText(ctx.message)}`);
    console.log(`   From Self: ${filter.fromSelf(ctx.message, ctx.client)}`);

    // Check for intent messages (inline action responses)
    // Agent SDK may expose contentType differently, check multiple ways
    const contentType =
      (ctx.message as any).contentType || (ctx.message as any).contentTypeId;
    const contentTypeId = contentType?.typeId || contentType?.typeId;

    if (
      contentTypeId === "intent" ||
      (ctx.message as any).contentType?.typeId === "intent"
    ) {
      console.log("   🎯 Detected intent message");
      try {
        const intentContent = ctx.message.content as IntentContent;
        if (intentContent && intentContent.actionId) {
          console.log(
            `   Intent ID: ${intentContent.id}, Action ID: ${intentContent.actionId}`
          );

          // Handle intent messages (join button clicks, etc.)
          await handleIntentMessage(ctx, intentContent, agent, gameManager);
          console.log("=".repeat(60));
          return;
        }
      } catch (error) {
        console.error("Error parsing intent message:", error);
      }
    }

    // Also check if content is an object with intent structure (fallback)
    if (typeof ctx.message.content === "object" && ctx.message.content !== null) {
      const content = ctx.message.content as any;
      if (content.actionId && content.id) {
        console.log("   🎯 Detected intent message (fallback detection)");
        try {
          const intentContent = content as IntentContent;
          await handleIntentMessage(ctx, intentContent, agent, gameManager);
          console.log("=".repeat(60));
          return;
        } catch (error) {
          console.error("Error handling intent message:", error);
        }
      }
    }

    if (!filter.isText(ctx.message) || filter.fromSelf(ctx.message, ctx.client)) {
      console.log("   ⏭️  Skipped: Not a text message or from self");
      console.log("=".repeat(60));
      return;
    }

    const content = ctx.message.content;
    const agentAddress = agent.address?.toLowerCase() || "";
    const agentInboxId = agent.client.inboxId;

    // Check if this is a DM (always process DMs)
    const isDM = ctx.conversation && !("addMembers" in ctx.conversation);
    console.log(`   Is DM: ${isDM}`);

    // Parse command first to check if it's a kill command in DM
    const parsed = parseCommand(content);
    
    // For groups, verify agent is a member and require mention
    if (!isDM) {
      // Check if agent is in the group
      const agentInGroup = await isAgentInGroup(ctx.conversation, agentInboxId);
      console.log(`   Agent in group: ${agentInGroup}`);

      if (!agentInGroup) {
        console.log("   ⏭️  Skipped: Agent is not a member of this group");
        console.log("=".repeat(60));
        // Send error message to user
        try {
          await ctx.sendText(
            "❌ I'm not a member of this group. Please add me to the group first."
          );
        } catch (error) {
          console.error("Error sending message:", error);
        }
        return;
      }

      // Require mention for group commands
      if (!isMentioned(content, agentAddress)) {
        console.log("   ⏭️  Skipped: No mention in group message");
        console.log("=".repeat(60));
        return;
      }
    } else {
      // In DM: allow kill commands without mention, but other commands still need parsing
      // Kill commands are handled specially - they don't need mention in DM
      if (parsed && parsed.command === "kill") {
        // Allow kill command in DM without mention
        console.log(`   ✅ Kill command in DM (no mention required)`);
        console.log("=".repeat(60));
        (ctx as any).parsedCommand = parsed;
        await next();
        return;
      }
    }

    if (!parsed) {
      console.log(
        "   ℹ️  Simple message (not a command) - will be handled by intro handler"
      );
      console.log("=".repeat(60));
      // Still call next() so simple message handlers can process it
      await next();
      return;
    }

    console.log(
      `   ✅ Command parsed: ${parsed.command} with args: [${parsed.args.join(", ")}]`
    );
    console.log("=".repeat(60));

    // Store parsed command in context for handlers
    (ctx as any).parsedCommand = parsed;
    await next();
  };
}


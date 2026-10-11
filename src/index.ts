import { Spectrum } from "spectrum-ts";
import { imessage } from "spectrum-ts/providers/imessage";
import { terminal } from "spectrum-ts/providers/terminal";
import { CaseEngine, type DmOpener } from "./cases.js";

const projectId = process.env.SPECTRUM_PROJECT_ID;
const projectSecret = process.env.SPECTRUM_PROJECT_SECRET;
if (!projectId || !projectSecret) {
  throw new Error("SPECTRUM_PROJECT_ID and SPECTRUM_PROJECT_SECRET must be set — see .env.example.");
}
if (!process.env.ANTHROPIC_API_KEY) {
  throw new Error("ANTHROPIC_API_KEY must be set — see .env.example.");
}

const spectrum = await Spectrum({
  projectId,
  projectSecret,
  providers: [imessage.config(), terminal.config()],
});

const im = imessage(spectrum);
const term = terminal(spectrum);

const openDm: DmOpener = async (platform, userId) => {
  if (platform === "imessage") return im.space.create(userId);
  if (platform === "terminal") return term.space.create(userId);
  throw new Error(`No platform instance registered for "${platform}"`);
};

const engine = new CaseEngine(openDm);

process.on("SIGINT", async () => {
  await spectrum.stop();
  process.exit(0);
});

console.log("⚖️ Hung Jury is now in session. Listening for messages...");

for await (const [space, message] of spectrum.messages) {
  try {
    await engine.handleMessage(space, message);
  } catch (err) {
    console.error("Error handling message:", err);
  }
}

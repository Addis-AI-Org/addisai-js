import AddisAI from "addisai";
import { createWriteStream } from "node:fs";
import { once } from "node:events";

const addis = new AddisAI(); // ADDIS_API_KEY
const text = process.argv[2];
if (!text) throw new Error('Usage: node examples/realtime.mjs "A complete sentence to speak"');
const language = process.env.ADDIS_VOICE_LANGUAGE ?? "am";
const voiceId = process.env.ADDIS_VOICE_ID ?? "am-hamen";
const connection = await addis.realtime.connect({ voiceId, language });
const file = createWriteStream("realtime-speech.mp3");
try {
  for await (const bytes of connection.speak(text)) {
    if (!file.write(bytes)) await once(file, "drain");
  }
  file.end();
  await once(file, "finish");
  console.log(connection.lastCompletion?.usage);
} finally {
  connection.close();
  file.destroy();
}

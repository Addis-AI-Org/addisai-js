// Transcribe audio and translate text.
//   ADDIS_API_KEY=... node examples/speech-translate.mjs ./call.wav
import AddisAI, { fileFromPath } from "addisai";

const addis = new AddisAI();

const path = process.argv[2] ?? "./call.wav";
const { text } = await addis.speech.transcribe({
  audio: await fileFromPath(path),
  language: "am",
});
console.log("transcript:", text);

const en = await addis.translate.create({ text, from: "am", to: "en" });
console.log("english:", en.text);

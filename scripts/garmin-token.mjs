#!/usr/bin/env node
/**
 * Generates the Garmin token for MatouRun, from your own computer.
 *
 * Garmin blocks sign-ins coming from hosting servers (Render), so the sign-in
 * happens here once; the server then only uses the token (valid about a year).
 *
 *   npm install garmin-connect@1.6.2
 *   node garmin-token.mjs
 *
 * Paste the printed token into the GARMIN_TOKENS variable on Render.
 * Your password is only sent to Garmin, never stored or printed.
 */
import readline from "node:readline";
import pkg from "garmin-connect";

const { GarminConnect } = pkg;

const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: process.stdin.isTTY });
let muted = false;
rl._writeToOutput = (s) => {
  if (!muted) rl.output.write(s);
  else if (s.includes("\n") || s.includes("\r")) rl.output.write("\n");
};
const lines = rl[Symbol.asyncIterator]();

async function ask(question, hidden = false) {
  rl.output.write(question);
  muted = hidden;
  const { value = "" } = await lines.next();
  muted = false;
  return value.trim();
}

const email = await ask("E-mail Garmin Connect : ");
const password = await ask("Mot de passe Garmin Connect (masqué) : ", true);
rl.close();
if (!email || !password) {
  console.error("E-mail et mot de passe requis.");
  process.exit(1);
}

console.log("\nConnexion à Garmin…");
const gc = new GarminConnect({ username: email, password });
try {
  await gc.login();
} catch (err) {
  const msg = String(err?.message ?? err);
  console.error("\nÉchec de la connexion à Garmin.");
  if (/429|rate/i.test(msg)) console.error("Garmin limite les connexions : réessaie dans une heure.");
  else if (/MFA|Ticket/i.test(msg)) console.error("Identifiants refusés, ou double authentification activée sur le compte.");
  else console.error(msg.slice(0, 300));
  process.exit(1);
}

const token = Buffer.from(JSON.stringify(gc.exportToken())).toString("base64url");
console.log("\nConnexion réussie. Copie la ligne ci-dessous dans la variable GARMIN_TOKENS sur Render.");
console.log("Ne la partage avec personne : elle donne accès à ton compte Garmin.\n");
console.log(token);
console.log("");

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import JSZip from "jszip";
import type { Express } from "express";
import { birthYears, categoryAt, parseCategoryCell, seasonYear } from "../../shared/categories.js";
import { parseDateCell, readCalendarDocx, seasonFromText } from "../src/lib/calendarDocx.js";

describe("FFA categories", () => {
  it("follows the athle.fr table for the 2027 season", () => {
    expect(birthYears("ES", 2027)).toEqual([2005, 2007]);
    expect(birthYears("JU", 2027)).toEqual([2008, 2009]);
    expect(birthYears("SE", 2027)).toEqual([1993, 2004]);
    expect(birthYears("EA", 2027)).toEqual([2018, 2020]);
  });

  it("puts someone born 30 May 2006 in Espoirs until August 2028, Seniors after", () => {
    const born = "2006-05-30";
    expect(seasonYear("2026-10-21")).toBe(2027);
    expect(seasonYear("2027-08-31")).toBe(2027);
    expect(seasonYear("2027-09-01")).toBe(2028);
    expect(categoryAt(born, "2026-10-25")).toBe("ES");
    expect(categoryAt(born, "2028-08-31")).toBe("ES");
    expect(categoryAt(born, "2028-09-01")).toBe("SE");
    expect(categoryAt(born, "2025-08-31")).toBe("JU");
  });

  it("reads the club's glued notation", () => {
    expect(parseCategoryCell("ESMa")).toEqual(["ES", "SE", "MA"]);
    expect(parseCategoryCell("CJESMa")).toEqual(["CA", "JU", "ES", "SE", "MA"]);
    expect(parseCategoryCell("EA,P,B,M")).toEqual(["EA", "PO", "BE", "MI"]); // éveils, not espoirs
    expect(parseCategoryCell("EAP")).toEqual(["EA", "PO"]);
    expect(parseCategoryCell("MCJESM")).toEqual(["MI", "CA", "JU", "ES", "SE"]);
    expect(parseCategoryCell("Toutes")).toHaveLength(10);
    expect(parseCategoryCell("")).toBeNull();
    expect(parseCategoryCell("XYZ")).toBeNull();
  });

  it("reads dates and seasons", () => {
    expect(seasonFromText("Calendrier saison hivernale 2026/2027")).toBe(2026);
    expect(seasonFromText("saison 2026-27")).toBe(2026);
    expect(parseDateCell("25/10", 2026)).toEqual({ start: "2026-10-25", end: "2026-10-25" });
    expect(parseDateCell("16-17/01", 2026)).toEqual({ start: "2027-01-16", end: "2027-01-17" });
    expect(parseDateCell("30/02", 2026)).toBeNull();
    expect(parseDateCell("17-16/01", 2026)).toBeNull();
    expect(parseDateCell("bientôt", 2026)).toBeNull();
  });
});

async function makeDocx(rows: string[][], title = "Calendrier saison hivernale 2026/2027") {
  const esc = (t: string) => t.replace(/&/g, "&amp;").replace(/</g, "&lt;");
  const cell = (t: string) => `<w:tc><w:tcPr/><w:p><w:r><w:t xml:space="preserve">${esc(t)}</w:t></w:r></w:p></w:tc>`;
  const xml = `<?xml version="1.0"?><w:document xmlns:w="x"><w:body><w:p><w:r><w:t>${esc(title)}</w:t></w:r></w:p>
    <w:tbl>${rows.map((r) => `<w:tr w:rsidR="1">${r.map(cell).join("")}</w:tr>`).join("")}</w:tbl></w:body></w:document>`;
  const zip = new JSZip();
  zip.file("[Content_Types].xml", "<Types/>");
  zip.file("word/document.xml", xml);
  return zip.generateAsync({ type: "nodebuffer" });
}

describe("calendar .docx", () => {
  it("reads the table whatever the column order", async () => {
    const file = await makeDocx([
      ["Lieux", "Date", "Intitulé", "Cat"],
      ["Lille", "25/10", "Semi & marathon de Lille", "ESMa"],
      ["Val de Reuil", "30/01", "Meeting de l’Eure", ""],
      ["?", "16-17/01", "Régionaux élite", "CJESMa"],
      ["", "", "", ""],
      ["Vernon", "un jour", "Date illisible", "Toutes"],
    ]);
    const r = await readCalendarDocx(file, 2030);
    expect(r.seasonStart).toBe(2026);
    expect(r.skipped).toBe(1);
    expect(r.rows).toEqual([
      { startDate: "2026-10-25", endDate: "2026-10-25", title: "Semi & marathon de Lille", place: "Lille", categories: ["ES", "SE", "MA"] },
      { startDate: "2027-01-30", endDate: "2027-01-30", title: "Meeting de l’Eure", place: "Val de Reuil", categories: null },
      { startDate: "2027-01-16", endDate: "2027-01-17", title: "Régionaux élite", place: null, categories: ["CA", "JU", "ES", "SE", "MA"] },
    ]);
  });

  it("refuses files that aren't a calendar", async () => {
    await expect(readCalendarDocx(Buffer.from("%PDF-1.7 pas un docx"), 2026)).rejects.toMatchObject({ status: 415 });
    await expect(readCalendarDocx(await makeDocx([["Nom", "Prénom"], ["a", "b"]]), 2026)).rejects.toMatchObject({ status: 422 });
  });
});

let app: Express;
let closeDb: () => Promise<void>;
const ORIGIN = { Origin: "http://matourun.test" };
const as = (t: string) => ({ Authorization: `Bearer ${t}`, ...ORIGIN });
let admin = "";
let member = "";

describe("competitions API", () => {
  beforeAll(async () => {
    Object.assign(process.env, {
      NODE_ENV: "test",
      DATABASE_URL: process.env.TEST_DATABASE_URL ?? "postgres://postgres@localhost:5433/matourun_test?host=/tmp",
      DATABASE_SSL: "false",
      JWT_SECRET: "c".repeat(48),
      SETUP_CODE: "code-de-setup-123",
      APP_ORIGIN: "http://matourun.test",
    });
    const { resetEnvCache } = await import("../src/env.js");
    resetEnvCache();
    const dbm = await import("../src/db.js");
    closeDb = dbm.closeDb;
    await dbm.migrate();
    await dbm.q("TRUNCATE users, refresh_tokens, profiles, sessions, app_secrets, competitions CASCADE");
    const { seedCompetitions } = await import("../src/lib/competitions.js");
    await seedCompetitions();
    await seedCompetitions(); // idempotent
    app = (await import("../src/app.js")).createApp();
    admin = (await request(app).post("/api/auth/setup").set(ORIGIN).send({ email: "admin@example.fr", password: "mot-de-passe-admin", setupCode: "code-de-setup-123" })).body.accessToken;
    const inv = await request(app).post("/api/admin/users").set(as(admin)).send({ email: "membre@example.fr" });
    member = (await request(app).post("/api/auth/setup").set(ORIGIN).send({ email: "membre@example.fr", password: "mot-de-passe-membre", setupCode: inv.body.inviteCode })).body.accessToken;
  });

  afterAll(async () => closeDb?.());

  it("loads the 2026-2027 calendar once", async () => {
    const all = await request(app).get("/api/competitions?all=1").set(as(admin));
    expect(all.body.items).toHaveLength(42);
  });

  it("keeps only an Espoir's competitions once the birth date is known", async () => {
    let r = await request(app).get("/api/competitions").set(as(admin));
    expect(r.body.birthDate).toBeNull();
    expect(r.body.items).toHaveLength(42); // unknown category: nothing hidden

    const profile = (await request(app).get("/api/profile").set(as(admin))).body;
    const saved = await request(app).put("/api/profile").set(as(admin)).send({ ...profile, birthDate: "2006-05-30" });
    expect(saved.status).toBe(200);
    expect((await request(app).put("/api/profile").set(as(admin)).send({ ...profile, birthDate: "2999-01-01" })).status).toBe(400);

    r = await request(app).get("/api/competitions").set(as(admin));
    expect(r.body.items).toHaveLength(26);
    const titles = r.body.items.map((c: { title: string }) => c.title);
    expect(titles).toContain("France U23 et nationaux");
    expect(titles).toContain("Cross de Vernon");
    expect(titles).not.toContain("Cross d’Evreux");
    expect(titles).not.toContain("France U18 & U20");
    const meeting = r.body.items.find((c: { title: string }) => c.title === "Meeting de l’Eure");
    expect(meeting).toMatchObject({ eligible: null, myCategory: "ES" });
  });

  it("marks the competitions you go to, per person", async () => {
    const r = await request(app).get("/api/competitions").set(as(admin));
    const france5k = r.body.items.find((c: { title: string }) => c.title === "France 5 km");
    expect((await request(app).put(`/api/competitions/${france5k.id}/going`).set(as(admin)).send({ going: true })).status).toBe(204);
    const week = await request(app).get("/api/week-competitions?from=2026-12-14&to=2026-12-20").set(as(admin));
    expect(week.body).toEqual([{ id: france5k.id, startDate: "2026-12-19", endDate: "2026-12-19", title: "France 5 km", place: "Vincennes" }]);
    const other = await request(app).get("/api/week-competitions?from=2026-12-14&to=2026-12-20").set(as(member));
    expect(other.body).toEqual([]);
    expect((await request(app).put(`/api/competitions/00000000-0000-4000-8000-000000000000/going`).set(as(admin)).send({ going: true })).status).toBe(404);
  });

  it("lets only admins import a new calendar, keeping entries on unchanged races", async () => {
    const file = await makeDocx([
      ["Date", "Intitulé", "Cat", "Lieux"],
      ["19/12", "France 5 km", "CJESMa", "Vincennes"],
      ["02/05", "Nouvelle course", "Toutes", "Rouen"],
    ]);
    expect((await request(app).post("/api/competitions/import").set(as(member)).attach("file", file, "cal.docx")).status).toBe(403);
    const preview = await request(app).post("/api/competitions/import").set(as(admin)).attach("file", file, "cal.docx");
    expect(preview.status).toBe(200);
    expect(preview.body).toMatchObject({ season: "2026-2027", skipped: 0 });
    expect(preview.body.rows).toHaveLength(2);

    expect((await request(app).post("/api/competitions/save").set(as(member)).send(preview.body)).status).toBe(403);
    expect((await request(app).post("/api/competitions/save").set(as(admin)).send(preview.body)).body).toEqual({ saved: 2 });
    const r = await request(app).get("/api/competitions?all=1").set(as(admin));
    expect(r.body.items.map((c: { title: string }) => c.title)).toEqual(["France 5 km", "Nouvelle course"]);
    expect(r.body.items[0].going).toBe(true); // kept
  });
});

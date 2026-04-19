/**
 * scripts/generate-qrs.ts — print-ready PDF with one QR poster per pilot store.
 *
 * Usage:
 *   tsx scripts/generate-qrs.ts                # reads APP_URL from env
 *   APP_URL=https://safereport.example tsx scripts/generate-qrs.ts
 *
 * Output: out/qr-posters.pdf (A4 portrait, one poster per page)
 *
 * Each poster encodes `${APP_URL}/r/${sap_code}` — the reporter landing URL.
 * A4 @ 72dpi is 595 × 842 pt. Layout is intentionally simple: brand + store
 * name at top, QR centred, SAP code + call-to-action at bottom.
 *
 * Fonts: we embed only the standard PDF fonts (Helvetica family) so the
 * script runs on a Windows laptop with zero system-font dependencies.
 */

import { createClient } from "@supabase/supabase-js"
import { PDFDocument, StandardFonts, rgb } from "pdf-lib"
import QRCode from "qrcode"
import { mkdir, writeFile } from "node:fs/promises"
import { resolve } from "node:path"
import { config as loadEnv } from "dotenv"

// Load .env.local so this script picks up the same Supabase keys the app uses.
loadEnv({ path: ".env.local" })

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY
// Trim whitespace defensively — a stray trailing space in .env.local or in a
// Railway env var turns into `%20` when the URL gets concatenated with the
// SAP code, and mobile browsers won't forgive that (desktop sometimes does).
const APP_URL = (
  process.env.APP_URL ||
  process.env.NEXT_PUBLIC_APP_URL ||
  "http://localhost:3000"
)
  .trim()
  .replace(/\/$/, "")

if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error(
    "Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY — check .env.local",
  )
  process.exit(1)
}

type Store = {
  sap_code: string
  name: string
  brand: string
  city: string
}

async function loadStores(): Promise<Store[]> {
  const sb = createClient(SUPABASE_URL!, SUPABASE_KEY!, {
    auth: { persistSession: false },
  })
  const { data, error } = await sb
    .from("stores")
    .select("sap_code, name, brand, city")
    .eq("status", "active")
    .order("sap_code", { ascending: true })
  if (error) {
    console.error("Supabase query failed:", error)
    process.exit(1)
  }
  return (data as Store[]) ?? []
}

// Brand hex. Mirrors the in-app palette (Indigo 700 primary), keeping the
// poster in the same visual language as the PWA itself.
const INDIGO_700 = rgb(0x43 / 255, 0x38 / 255, 0xca / 255)
const SLATE_900 = rgb(0x0f / 255, 0x17 / 255, 0x2a / 255)
const SLATE_500 = rgb(0x64 / 255, 0x74 / 255, 0x8b / 255)
const SLATE_200 = rgb(0xe2 / 255, 0xe8 / 255, 0xf0 / 255)

// A4 portrait in points (72dpi). pdf-lib's default unit.
const PAGE_W = 595.28
const PAGE_H = 841.89

async function renderQrPng(url: string): Promise<Uint8Array> {
  // 800px is plenty of resolution for an A4 print centre tile (~11cm wide).
  const buf = await QRCode.toBuffer(url, {
    type: "png",
    errorCorrectionLevel: "H", // survive smudges / poster creases
    margin: 2,
    width: 800,
    color: {
      dark: "#0F172A", // slate-900
      light: "#FFFFFF",
    },
  })
  return new Uint8Array(buf)
}

async function buildPdf(stores: Store[]) {
  const pdf = await PDFDocument.create()
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold)
  const regular = await pdf.embedFont(StandardFonts.Helvetica)

  for (const s of stores) {
    const page = pdf.addPage([PAGE_W, PAGE_H])

    // Page margin rule at the top — subtle "SafeReport" mark for branding.
    page.drawRectangle({
      x: 0,
      y: PAGE_H - 6,
      width: PAGE_W,
      height: 6,
      color: INDIGO_700,
    })

    // Wordmark
    const brandMark = "SafeReport"
    const brandSize = 14
    page.drawText(brandMark, {
      x: 48,
      y: PAGE_H - 42,
      size: brandSize,
      font: bold,
      color: INDIGO_700,
    })

    // ABFRL pilot note
    page.drawText("ABFRL safety reporting · pilot", {
      x: 48,
      y: PAGE_H - 62,
      size: 10,
      font: regular,
      color: SLATE_500,
    })

    // Store heading block — brand on top, store name below it.
    const headingYTop = PAGE_H - 120
    page.drawText(s.brand.toUpperCase(), {
      x: 48,
      y: headingYTop,
      size: 11,
      font: bold,
      color: SLATE_500,
    })
    // Title — wrap by budgeting width (no built-in wrap in pdf-lib). Most
    // store names fit one line at 28pt across A4 width (~500 pt usable).
    const title = s.name
    page.drawText(title, {
      x: 48,
      y: headingYTop - 32,
      size: 28,
      font: bold,
      color: SLATE_900,
    })
    page.drawText(s.city, {
      x: 48,
      y: headingYTop - 58,
      size: 13,
      font: regular,
      color: SLATE_500,
    })

    // QR tile — centred horizontally, large enough to scan from arm's length.
    const qrSize = 340
    const qrX = (PAGE_W - qrSize) / 2
    const qrY = (PAGE_H - qrSize) / 2 - 30
    const pngBytes = await renderQrPng(`${APP_URL}/r/${s.sap_code}`)
    const pngImage = await pdf.embedPng(pngBytes)
    // Soft slate background tile so the QR has breathing room
    page.drawRectangle({
      x: qrX - 16,
      y: qrY - 16,
      width: qrSize + 32,
      height: qrSize + 32,
      color: SLATE_200,
    })
    page.drawImage(pngImage, {
      x: qrX,
      y: qrY,
      width: qrSize,
      height: qrSize,
    })

    // Call-to-action under the QR.
    const ctaTop = qrY - 46
    const cta1 = "Scan to report a safety issue"
    const cta1Size = 18
    const cta1Width = bold.widthOfTextAtSize(cta1, cta1Size)
    page.drawText(cta1, {
      x: (PAGE_W - cta1Width) / 2,
      y: ctaTop,
      size: cta1Size,
      font: bold,
      color: SLATE_900,
    })
    const cta2 = "Voice in any language · Photo · 30 seconds"
    const cta2Size = 12
    const cta2Width = regular.widthOfTextAtSize(cta2, cta2Size)
    page.drawText(cta2, {
      x: (PAGE_W - cta2Width) / 2,
      y: ctaTop - 22,
      size: cta2Size,
      font: regular,
      color: SLATE_500,
    })

    // Footer — SAP code (helps ops spot mis-posted posters at a glance).
    const footer = `Store code: ${s.sap_code}`
    const footerSize = 10
    const footerWidth = regular.widthOfTextAtSize(footer, footerSize)
    page.drawText(footer, {
      x: (PAGE_W - footerWidth) / 2,
      y: 48,
      size: footerSize,
      font: regular,
      color: SLATE_500,
    })
  }

  return await pdf.save()
}

async function main() {
  const stores = await loadStores()
  if (stores.length === 0) {
    console.error("No active stores found — is the stores table seeded?")
    process.exit(1)
  }
  console.log(`Generating ${stores.length} QR poster(s) for ${APP_URL}/r/...`)
  const bytes = await buildPdf(stores)
  const outDir = resolve(process.cwd(), "out")
  await mkdir(outDir, { recursive: true })
  const outPath = resolve(outDir, "qr-posters.pdf")
  await writeFile(outPath, bytes)
  console.log(`✓ Wrote ${outPath} (${(bytes.length / 1024).toFixed(1)} KB)`)
  console.log(
    `  ${stores.length} pages — one poster per active store, A4 portrait.`,
  )
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})

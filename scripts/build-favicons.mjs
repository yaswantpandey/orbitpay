import fs from "fs";
import path from "path";
import sharp from "sharp";
import { createIco } from "./make-ico.mjs";

const svgContent = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" width="512" height="512">
  <defs>
    <!-- Background Obsidian Gradient -->
    <linearGradient id="bgGrad" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#0F172A" />
      <stop offset="50%" stop-color="#090D16" />
      <stop offset="100%" stop-color="#020617" />
    </linearGradient>

    <!-- Outer Border Glow Gradient -->
    <linearGradient id="rimGrad" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#00F5A0" stop-opacity="0.6" />
      <stop offset="50%" stop-color="#00D9F5" stop-opacity="0.35" />
      <stop offset="100%" stop-color="#0066FF" stop-opacity="0.1" />
    </linearGradient>

    <!-- High-Energy FastPay F-Bolt Gradient -->
    <linearGradient id="fboltGrad" x1="10%" y1="0%" x2="90%" y2="100%">
      <stop offset="0%" stop-color="#00F5A0" />
      <stop offset="40%" stop-color="#00D9F5" />
      <stop offset="100%" stop-color="#0066FF" />
    </linearGradient>

    <!-- Center Radial Glow -->
    <radialGradient id="centerGlow" cx="45%" cy="40%" r="55%">
      <stop offset="0%" stop-color="#00F5A0" stop-opacity="0.32" />
      <stop offset="50%" stop-color="#00D9F5" stop-opacity="0.1" />
      <stop offset="100%" stop-color="#020617" stop-opacity="0" />
    </radialGradient>

    <!-- Dynamic Neon Drop Shadow -->
    <filter id="glowFilter" x="-20%" y="-20%" width="140%" height="140%">
      <feDropShadow dx="0" dy="8" stdDeviation="14" flood-color="#00F5A0" flood-opacity="0.45" />
      <feDropShadow dx="0" dy="2" stdDeviation="6" flood-color="#00D9F5" flood-opacity="0.5" />
    </filter>
  </defs>

  <!-- Squircle Base -->
  <rect width="512" height="512" rx="124" fill="url(#bgGrad)" />
  <rect width="508" height="508" x="2" y="2" rx="122" fill="none" stroke="url(#rimGrad)" stroke-width="2.5" />

  <!-- Ambient Light -->
  <circle cx="256" cy="240" r="180" fill="url(#centerGlow)" />

  <!-- Unified F-Bolt Mark -->
  <g filter="url(#glowFilter)">
    <path d="M 148 116 
             C 148 107.2 155.2 100 164 100 
             L 362 100 
             C 374.2 100 382.3 113.1 376.6 123.9 
             L 344 186 
             C 340.4 192.8 333.4 197 325.7 197 
             L 246 197 
             L 226 235 
             L 316 235 
             C 328.2 235 336.3 248.1 330.6 258.9 
             L 300 317 
             C 296.4 323.8 289.4 328 281.7 328 
             L 218 328 
             L 258 424 
             C 264.4 439.4 245.5 450.6 234.3 438.2 
             L 168 365 
             C 161.4 357.7 157.7 348.1 157.7 338.2 
             L 157.7 328 
             L 148 328 
             Z" 
          fill="url(#fboltGrad)" />

    <!-- Digital Currency Spark / Pay Chip -->
    <circle cx="376" cy="276" r="16" fill="#00F5A0" />
    <circle cx="376" cy="276" r="8" fill="#FFFFFF" opacity="0.9" />
  </g>
</svg>`;

async function buildAll() {
  const svgBuf = Buffer.from(svgContent);

  // 1. Save SVG files
  fs.writeFileSync("src/app/icon.svg", svgContent, "utf8");
  fs.writeFileSync("public/icon.svg", svgContent, "utf8");
  console.log("✓ Saved src/app/icon.svg and public/icon.svg");

  // 2. Generate PNG buffers at various sizes
  const p16 = await sharp(svgBuf).resize(16, 16).png().toBuffer();
  const p32 = await sharp(svgBuf).resize(32, 32).png().toBuffer();
  const p48 = await sharp(svgBuf).resize(48, 48).png().toBuffer();
  const p180 = await sharp(svgBuf).resize(180, 180).png().toBuffer();
  const p192 = await sharp(svgBuf).resize(192, 192).png().toBuffer();
  const p512 = await sharp(svgBuf).resize(512, 512).png().toBuffer();

  // 3. Apple Touch Icon (180x180)
  fs.writeFileSync("src/app/apple-icon.png", p180);
  fs.writeFileSync("public/apple-icon.png", p180);
  console.log("✓ Saved apple-icon.png (180x180)");

  // 4. PWA Icons (192x192 & 512x512)
  fs.writeFileSync("public/icon-192.png", p192);
  fs.writeFileSync("public/icon-512.png", p512);
  console.log("✓ Saved public/icon-192.png and public/icon-512.png");

  // 5. Generate Multi-Resolution ICO (16x16, 32x32, 48x48)
  const icoBuffer = await createIco([
    { width: 16, height: 16, buffer: p16 },
    { width: 32, height: 32, buffer: p32 },
    { width: 48, height: 48, buffer: p48 },
  ]);

  fs.writeFileSync("src/app/favicon.ico", icoBuffer);
  fs.writeFileSync("public/favicon.ico", icoBuffer);
  console.log("✓ Saved multi-resolution favicon.ico to src/app and public");

  // 6. Web Manifest
  const manifest = {
    name: "OrbitPay — Global Digital Wallet",
    short_name: "OrbitPay",
    description: "Hold, send and receive money worldwide with instant borderless payments.",
    start_url: "/",
    display: "standalone",
    background_color: "#090D16",
    theme_color: "#090D16",
    icons: [
      {
        src: "/icon-192.png",
        sizes: "192x192",
        type: "image/png",
        purpose: "any maskable"
      },
      {
        src: "/icon-512.png",
        sizes: "512x512",
        type: "image/png",
        purpose: "any maskable"
      }
    ]
  };

  fs.writeFileSync("public/manifest.json", JSON.stringify(manifest, null, 2), "utf8");
  console.log("✓ Saved public/manifest.json");

  console.log("All favicon assets generated successfully!");
}

buildAll().catch((err) => {
  console.error(err);
  process.exit(1);
});


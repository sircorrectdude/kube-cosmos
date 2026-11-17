// Lastszenario "aus dem Universum": externe Requests über den Traefik-Ingress (Host shop.local),
// pro Service ein eigener, zeitlich variierender Lastverlauf. Keine Abhängigkeiten.
// Aufruf: node demo/load-scenario.mjs [Dauer in s = 300] [Ingress-URL = http://localhost]
import http from 'node:http';

const DURATION = Number(process.argv[2] ?? 300);
const BASE = new URL(process.argv[3] ?? process.env.INGRESS_URL ?? 'http://localhost');
const agent = new http.Agent({ keepAlive: true, maxSockets: 64 });

const wave = (t, period, min, max) => min + (max - min) * (0.5 + 0.5 * Math.sin((2 * Math.PI * t) / period));
const PROFILES = [
  // Name, Pfad, Rate (Requests/s) als Funktion der Zeit t in Sekunden
  { name: 'catalog', path: () => '/catalog/', rate: t => wave(t, 80, 2, 40) },                        // Welle, Periode 80 s
  { name: 'cart',    path: () => '/cart/',    rate: t => (t % 45 < 12 ? 35 : 2) },                       // Burst: 12 s von 45 s
  { name: 'payment', path: t => (t >= 120 && t < 150 ? '/pay/heavy' : '/pay/'),                       // Spitze bei 2:00–2:30
                     rate: t => (t >= 120 && t < 150 ? 30 : 1.5) },                                    // dort 25 % Fehler
  { name: 'api',     path: () => '/api/',     rate: t => 1 + 29 * Math.min(1, t / DURATION) },           // Rampe 1 → 30
  { name: 'home',    path: () => (Math.random() < 0.08 ? '/error' : '/'), rate: () => 3 },              // Grundrauschen
  // recommender: echte CPU-Last (sichtbar mit Prometheus: Pods glühen orange)
  { name: 'reco',    path: () => '/reco/work?n=70000', rate: t => wave(t, 100, 1, 35) },               // CPU-Welle, Periode 100 s (Spitze ≈ CPU-Limit)
];

// Speicher-Rampe auf recommender (sichtbar mit Prometheus: > 85 % des Limits → Pods pulsieren rot)
// 0:40–2:20 von 20 auf 165 MB je Pod (Limit 192Mi → ~89 %, ~25 MB Abstand gegen OOMKill), danach freigeben
const memTarget = t => (t >= 40 && t < 140 ? Math.round(20 + 145 * (t - 40) / 100) : 10);

const stats = Object.fromEntries(PROFILES.map(p => [p.name, { ok: 0, err: 0 }]));

function hit(p, t) {
  const req = http.request({ hostname: BASE.hostname, port: BASE.port || 80, path: p.path(t), agent,
    headers: { Host: 'shop.local', 'User-Agent': 'kube-cosmos-scenario' }, timeout: 5000 }, res => {
    res.resume();
    (res.statusCode < 500 ? stats[p.name].ok++ : stats[p.name].err++);
  });
  req.on('error', () => stats[p.name].err++);
  req.on('timeout', () => req.destroy());
  req.end();
}

const start = Date.now();
const acc = Object.fromEntries(PROFILES.map(p => [p.name, 0]));
const tick = setInterval(() => {
  const t = (Date.now() - start) / 1000;
  if (t >= DURATION) { clearInterval(tick); clearInterval(report); setTimeout(() => { console.log('Szenario beendet'); process.exit(0); }, 1000); return; }
  for (const p of PROFILES) {             // alle 50 ms: Anteil der Sollrate verschicken
    acc[p.name] += p.rate(t) * 0.05;
    while (acc[p.name] >= 1) { acc[p.name]--; hit(p, t); }
  }
}, 50);

// Speicherziel alle 2 s setzen; mehrere Requests, damit beide recommender-Pods es erhalten
setInterval(() => {
  const t = (Date.now() - start) / 1000;
  if (t >= DURATION) return;
  for (let i = 0; i < 6; i++) hit({ name: 'mem', path: () => `/reco/mem?mb=${memTarget(t)}` }, t);
}, 2000);
stats.mem = { ok: 0, err: 0 };

const report = setInterval(() => {
  const t = Math.round((Date.now() - start) / 1000);
  const line = PROFILES.map(p => `${p.name} ${p.rate(t).toFixed(0).padStart(2)}/s (${stats[p.name].err} Fehler)`).join(' | ')
    + ` | RAM-Ziel reco ${memTarget(t)} MB`;
  console.log(`${String(Math.floor(t / 60)).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}  ${line}`);
  for (const s of Object.values(stats)) { s.ok = 0; s.err = 0; }
}, 5000);

console.log(`Lastszenario ${DURATION}s gegen ${BASE.origin} (Host shop.local) – Strg+C bricht ab`);

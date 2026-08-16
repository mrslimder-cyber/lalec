#!/usr/bin/env node
/**
 * update-lec.mjs
 * ---------------------------------------------------------------------
 * Consulta la Cargo API de Leaguepedia para la LEC 2026 Summer, y
 * actualiza public-simulador/data.json con los resultados de las series
 * (Bo3) que ya se han jugado. NO toca nada más (ni el HTML ni el diseño).
 *
 * Se ejecuta desde GitHub Actions (ver .github/workflows/update-lec.yml),
 * pero también se puede correr a mano con:
 *   node scripts/update-lec.mjs
 *
 * IMPORTANTE — antes de dejarlo en piloto automático, verifica a mano:
 *   1) Que OVERVIEW_PAGE de abajo coincide EXACTAMENTE con el nombre de
 *      la página del torneo en Leaguepedia. Para comprobarlo, abre:
 *      https://lol.fandom.com/wiki/Special:CargoQuery
 *      y prueba una query con tables=MatchSchedule y ese OverviewPage.
 *   2) Que TEAM_NAME_TO_ID de abajo cubre los nombres EXACTOS que
 *      Leaguepedia usa para cada equipo (a veces difieren de la web,
 *      ej. patrocinadores o mayúsculas distintas).
 * Leaguepedia cambia de esquema de vez en cuando; si algún día esta
 * query deja de devolver filas, ese es el sitio por el que empezar.
 * ---------------------------------------------------------------------
 */

import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_PATH = path.join(__dirname, '..', 'data.json');

// --- 1) AJUSTA ESTO a la página real del torneo en Leaguepedia ---
// Ejemplo típico de nombre de página para la LEC: "LEC/2026 Season/Summer Season"
const OVERVIEW_PAGE = 'LEC/2026 Season/Summer Season';

// --- 2) Mapeo "nombre de equipo en Leaguepedia" -> "id usado en data.json" ---
const TEAM_NAME_TO_ID = {
  'G2 Esports': 'g2',
  'Fnatic': 'fnc',
  'Karmine Corp': 'kc',
  'Team Vitality': 'vit',
  'Team Heretics': 'th',
  'Movistar KOI': 'mkoi',
  'SK Gaming': 'sk',
  'GIANTX': 'gx',
  'Natus Vincere': 'navi',
  'Shifters': 'shf',
};

const CARGO_ENDPOINT = 'https://lol.fandom.com/api.php';

async function fetchSeriesResults() {
  const params = new URLSearchParams({
    action: 'cargoquery',
    format: 'json',
    limit: '500',
    tables: 'MatchSchedule=MS',
    fields: [
      'MS.Team1',
      'MS.Team2',
      'MS.Winner',
      'MS.Team1Score',
      'MS.Team2Score',
      'MS.DateTime_UTC',
    ].join(','),
    where: `MS.OverviewPage="${OVERVIEW_PAGE}"`,
  });

  const url = `${CARGO_ENDPOINT}?${params.toString()}`;

  // Los runners de GitHub Actions comparten IP con miles de repos que
  // también consultan Leaguepedia, así que es normal encontrarse el
  // límite de peticiones "ya gastado" sin que este script haya pedido
  // nada de más. Reintentamos con esperas crecientes antes de rendirnos.
  const MAX_ATTEMPTS = 5;
  const WAIT_MS = [60_000, 120_000, 180_000, 300_000]; // 1, 2, 3, 5 minutos

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const res = await fetch(url, {
      headers: {
        // Leaguepedia pide identificar el user-agent de scripts automatizados.
        'User-Agent': 'maurogarih-lec-simulador/1.0 (actualizacion automatica de resultados)',
      },
    });

    if (!res.ok) {
      throw new Error(`Leaguepedia respondió ${res.status} ${res.statusText}`);
    }

    const json = await res.json();

    const isRateLimited = json.error && json.error.code === 'ratelimited';
    if (isRateLimited) {
      if (attempt === MAX_ATTEMPTS) {
        throw new Error(`Cargo API error tras ${MAX_ATTEMPTS} intentos: ${json.error.info}`);
      }
      const wait = WAIT_MS[attempt - 1];
      console.log(`Rate limit de Leaguepedia (intento ${attempt}/${MAX_ATTEMPTS}). Esperando ${wait / 1000}s...`);
      await new Promise(r => setTimeout(r, wait));
      continue;
    }

    if (json.error) {
      throw new Error(`Cargo API error: ${json.error.info || JSON.stringify(json.error)}`);
    }

    return (json.cargoquery || []).map(row => row.title);
  }

  return []; // no debería llegar aquí, pero por si acaso
}

function seriesToResult(row) {
  const homeId = TEAM_NAME_TO_ID[row.Team1];
  const awayId = TEAM_NAME_TO_ID[row.Team2];
  if (!homeId || !awayId) return null; // equipo no reconocido: se ignora, no se rompe nada

  const winnerName = row.Winner === '1' ? row.Team1 : row.Winner === '2' ? row.Team2 : null;
  const winnerId = winnerName ? TEAM_NAME_TO_ID[winnerName] : null;
  if (!winnerId) return null; // serie sin ganador todavía (no jugada o en curso)

  const s1 = Number(row.Team1Score || 0);
  const s2 = Number(row.Team2Score || 0);
  const winnerGames = winnerId === homeId ? s1 : s2;
  const loserGames = winnerId === homeId ? s2 : s1;

  return {
    pairKey: [homeId, awayId].sort().join('|'), // para emparejar sin importar el orden
    winnerId,
    score: `${winnerGames}-${loserGames}`,
  };
}

async function main() {
  const raw = JSON.parse(await readFile(DATA_PATH, 'utf8'));
  const seriesRows = await fetchSeriesResults();
  const resultsByPair = new Map();
  for (const row of seriesRows) {
    const parsed = seriesToResult(row);
    if (parsed) resultsByPair.set(parsed.pairKey, parsed);
  }

  let changed = 0;
  for (const week of raw.schedule) {
    for (const match of week.matches) {
      const [homeId, awayId, date, existingResult] = match;
      if (existingResult) continue; // ya lo teníamos: no lo pisamos

      const pairKey = [homeId, awayId].sort().join('|');
      const found = resultsByPair.get(pairKey);
      if (found) {
        match[3] = [found.winnerId, found.score];
        changed++;
      }
    }
  }

  if (changed > 0) {
    await writeFile(DATA_PATH, JSON.stringify(raw, null, 2) + '\n', 'utf8');
    console.log(`✅ ${changed} resultado(s) nuevo(s) escritos en data.json`);
    // El workflow de GitHub Actions detecta el cambio con "git status" y
    // hace commit solo si data.json cambió de verdad — no hace falta
    // señalizar nada más desde aquí.
  } else {
    console.log('Sin cambios: no hay resultados nuevos todavía.');
  }
}

main().catch(err => {
  console.error('❌ Error actualizando resultados LEC:', err);
  process.exit(1);
});

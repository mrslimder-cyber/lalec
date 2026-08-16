/**
 * api/update-lec.js
 * ---------------------------------------------------------------------
 * Serverless function de Vercel. NO se ejecuta sola por cron de Vercel
 * (el plan Hobby no permite 2 ejecuciones/día) — la dispara un workflow
 * de GitHub Actions (.github/workflows/trigger-update-lec.yml) en el
 * horario exacto que quieras, con una petición POST autenticada.
 *
 * Qué hace, en orden:
 *   1) Comprueba que la petición trae el secreto correcto (si no, 401).
 *   2) Lee el data.json ACTUAL directamente desde GitHub (no desde el
 *      propio deploy, para no depender de si el deploy está al día).
 *   3) Consulta la Cargo API de Leaguepedia (con reintentos si hay
 *      rate limit) para los resultados de la LEC 2026 Summer.
 *   4) Si hay series nuevas terminadas, hace commit del data.json
 *      actualizado a GitHub vía la API — ese commit dispara el
 *      redeploy automático en Vercel, igual que si lo hubieras
 *      subido tú a mano.
 *
 * Variables de entorno necesarias (Vercel → Project → Settings →
 * Environment Variables):
 *   CRON_SECRET   → cadena secreta inventada por ti; la misma que
 *                    pondrás como secret en GitHub Actions.
 *   GITHUB_TOKEN  → Personal Access Token con permiso de escritura
 *                    sobre el repo (ver INSTRUCCIONES.md).
 *   GITHUB_REPO   → "usuario/nombre-repo"
 *   GITHUB_BRANCH → normalmente "main"
 *
 * IMPORTANTE — antes de confiar en esto en producción, verifica a mano
 * (igual que en la versión de GitHub Actions):
 *   - OVERVIEW_PAGE: nombre exacto del torneo en Leaguepedia.
 *   - TEAM_NAME_TO_ID: nombres exactos de equipo en Leaguepedia.
 * ---------------------------------------------------------------------
 */

const CARGO_ENDPOINT = 'https://lol.fandom.com/api.php';

// --- AJUSTA ESTO a la página real del torneo en Leaguepedia ---
const OVERVIEW_PAGE = 'LEC/2026 Season/Summer Season';

// --- Mapeo "nombre de equipo en Leaguepedia" -> "id usado en data.json" ---
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

async function fetchSeriesResults() {
  const params = new URLSearchParams({
    action: 'cargoquery',
    format: 'json',
    limit: '500',
    tables: 'MatchSchedule=MS',
    fields: ['MS.Team1', 'MS.Team2', 'MS.Winner', 'MS.Team1Score', 'MS.Team2Score'].join(','),
    where: `MS.OverviewPage="${OVERVIEW_PAGE}"`,
  });
  const url = `${CARGO_ENDPOINT}?${params.toString()}`;

  const MAX_ATTEMPTS = 4;
  const WAIT_MS = [20_000, 40_000, 60_000]; // más cortos que en Actions: la función tiene timeout

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const res = await fetch(url, {
      headers: { 'User-Agent': 'maurogarih-lec-simulador/1.0 (vercel function)' },
    });
    if (!res.ok) throw new Error(`Leaguepedia respondió ${res.status} ${res.statusText}`);
    const json = await res.json();

    if (json.error && json.error.code === 'ratelimited') {
      if (attempt === MAX_ATTEMPTS) throw new Error(`Cargo API rate limit tras ${MAX_ATTEMPTS} intentos`);
      await new Promise(r => setTimeout(r, WAIT_MS[attempt - 1]));
      continue;
    }
    if (json.error) throw new Error(`Cargo API error: ${json.error.info || JSON.stringify(json.error)}`);

    return (json.cargoquery || []).map(row => row.title);
  }
  return [];
}

function seriesToResult(row) {
  const homeId = TEAM_NAME_TO_ID[row.Team1];
  const awayId = TEAM_NAME_TO_ID[row.Team2];
  if (!homeId || !awayId) return null;

  const winnerName = row.Winner === '1' ? row.Team1 : row.Winner === '2' ? row.Team2 : null;
  const winnerId = winnerName ? TEAM_NAME_TO_ID[winnerName] : null;
  if (!winnerId) return null;

  const s1 = Number(row.Team1Score || 0);
  const s2 = Number(row.Team2Score || 0);
  const winnerGames = winnerId === homeId ? s1 : s2;
  const loserGames = winnerId === homeId ? s2 : s1;

  return { pairKey: [homeId, awayId].sort().join('|'), winnerId, score: `${winnerGames}-${loserGames}` };
}

async function getDataJsonFromGitHub() {
  const { GITHUB_TOKEN, GITHUB_REPO, GITHUB_BRANCH } = process.env;
  const url = `https://api.github.com/repos/${GITHUB_REPO}/contents/data.json?ref=${GITHUB_BRANCH}`;
  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${GITHUB_TOKEN}`,
      'User-Agent': 'lec-simulador-cron',
      Accept: 'application/vnd.github+json',
    },
  });
  if (!res.ok) throw new Error(`No se pudo leer data.json de GitHub: ${res.status} ${await res.text()}`);
  const json = await res.json();
  const content = Buffer.from(json.content, 'base64').toString('utf8');
  return { data: JSON.parse(content), sha: json.sha };
}

async function commitDataJsonToGitHub(newData, sha) {
  const { GITHUB_TOKEN, GITHUB_REPO, GITHUB_BRANCH } = process.env;
  const url = `https://api.github.com/repos/${GITHUB_REPO}/contents/data.json`;
  const contentB64 = Buffer.from(JSON.stringify(newData, null, 2) + '\n', 'utf8').toString('base64');
  const res = await fetch(url, {
    method: 'PUT',
    headers: {
      Authorization: `Bearer ${GITHUB_TOKEN}`,
      'User-Agent': 'lec-simulador-cron',
      Accept: 'application/vnd.github+json',
    },
    body: JSON.stringify({
      message: `Actualizar resultados LEC ${new Date().toISOString()}`,
      content: contentB64,
      sha,
      branch: GITHUB_BRANCH,
    }),
  });
  if (!res.ok) throw new Error(`No se pudo hacer commit en GitHub: ${res.status} ${await res.text()}`);
}

module.exports = async function handler(req, res) {
  const authHeader = req.headers['authorization'] || '';
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    res.status(401).json({ ok: false, error: 'No autorizado' });
    return;
  }

  try {
    const { data, sha } = await getDataJsonFromGitHub();
    const seriesRows = await fetchSeriesResults();

    const resultsByPair = new Map();
    for (const row of seriesRows) {
      const parsed = seriesToResult(row);
      if (parsed) resultsByPair.set(parsed.pairKey, parsed);
    }

    let changed = 0;
    for (const week of data.schedule) {
      for (const match of week.matches) {
        const [homeId, awayId, , existingResult] = match;
        if (existingResult) continue;
        const found = resultsByPair.get([homeId, awayId].sort().join('|'));
        if (found) {
          match[3] = [found.winnerId, found.score];
          changed++;
        }
      }
    }

    if (changed > 0) {
      await commitDataJsonToGitHub(data, sha);
    }

    res.status(200).json({ ok: true, changed });
  } catch (err) {
    console.error(err);
    res.status(500).json({ ok: false, error: String((err && err.message) || err) });
  }
};

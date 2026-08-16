# Automatismo LEC — para tu propio repo (index.html en la raíz)

## Qué añadir

Copia estos archivos a tu repo, respetando las rutas:

```
tu-repo/
  index.html            → REEMPLAZA tu index.html actual por este
  data.json               → nuevo, junto a index.html
  scripts/
    update-lec.mjs          → nuevo
  .github/workflows/
    update-lec.yml            → nuevo
```

`index.html` es tu mismo simulador, con dos cambios respecto al que
tenías:
1. El calendario/resultados ya no están incrustados en el `<script>`,
   se cargan con `fetch('data.json')` al abrir la página.
2. En vez de una semana fija (`activeRound = 3`), calcula sola cuál es
   la primera semana con partidos pendientes y aterriza ahí.

Todo lo demás (diseño, Monte Carlo, tiebreakers, modal de equipos...)
está intacto, no toqué nada de esa lógica.

## Antes de activarlo

1. **Verifica el nombre del torneo en Leaguepedia.** Abre
   `scripts/update-lec.mjs` y revisa la constante `OVERVIEW_PAGE`
   (ahora mismo pone `'LEC/2026 Season/Summer Season'`, es mi mejor
   estimación pero no la he podido confirmar en vivo). Compruébalo en
   https://lol.fandom.com/wiki/Special:CargoQuery haciendo una query
   sobre la tabla `MatchSchedule` con ese `OverviewPage`.
2. **Revisa `TEAM_NAME_TO_ID`** en el mismo archivo: son los nombres
   exactos que usa Leaguepedia para cada equipo. Si alguno no coincide
   (típico con patrocinadores o mayúsculas), el script simplemente
   ignorará ese partido en vez de romperse, pero no se actualizará.
3. Pruébalo en local antes de fiarte del cron:
   ```
   npm install   # si tu repo no tiene node_modules aún, no hace falta ninguna dependencia extra
   node scripts/update-lec.mjs
   ```
   Debería decir "Sin cambios" o "N resultado(s) nuevo(s) escritos".

## Activar el cron en GitHub

1. Haz push de todo a GitHub.
2. En el repo: `Settings → Actions → General → Workflow permissions`
   → marca **"Read and write permissions"** (si no, el workflow no
   podrá hacer commit del `data.json` actualizado).
3. En la pestaña **Actions** verás el workflow "Actualizar resultados
   LEC". Puedes lanzarlo a mano con "Run workflow" para probarlo antes
   de esperar al horario programado.

## Horario

Se ejecuta viernes, sábado, domingo y lunes a las **19:00 y 23:00,
hora de España** (convertido ya a UTC para el cron de GitHub Actions).
Si en algún momento cae fuera del horario de verano (a partir de
finales de octubre, cuando España pasa a CET/UTC+1), hay que cambiar
`17,21` por `18,22` en `.github/workflows/update-lec.yml` para que
siga siendo 19:00/23:00 en hora española.

## Qué pasa cada vez que se ejecuta

1. El script consulta Leaguepedia.
2. Si hay series nuevas terminadas, actualiza `data.json` y el propio
   workflow hace commit + push.
3. Ese push dispara un redeploy automático en Vercel.
4. Nadie tiene que entrar a tocar nada — ni tú.

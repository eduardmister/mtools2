/* ============================================================================
 * MisterTools · Scraper de FutbolFantasy  (GitHub Actions)
 * Selectores verificados sobre el HTML real (jul 2026).
 * Solo lee una web pública. Una pasada al día. No toca Mister.
 * ==========================================================================*/
import * as cheerio from 'cheerio';
import { writeFileSync } from 'fs';

const BASE = 'https://www.futbolfantasy.com/laliga/equipos/';
// Temporada 26/27. Ascendidos: Racing, Deportivo, Málaga.
// Descendidos (fuera): Oviedo, Levante, Elche.
// OJO: los slugs de equipos nuevos deben verificarse en futbolfantasy.com/laliga/equipos/
const EQUIPOS = [
  'alaves','athletic','atletico','barcelona','betis','celta','deportivo','espanyol',
  'getafe','girona','malaga','mallorca','osasuna','racing','rayo-vallecano','real-madrid',
  'real-sociedad','sevilla','valencia','villarreal'
];
// Slugs alternativos a probar si el principal da 404 (equipos nuevos).
const SLUG_ALTERNATIVAS = {
  'deportivo': ['deportivo','rc-deportivo','deportivo-la-coruna','dep'],
  'malaga': ['malaga','malaga-cf'],
  'racing': ['racing','racing-santander','real-racing-club','racing-de-santander']
};
const UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36';
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function normalizar(nombre) {
  return (nombre||'').normalize('NFD').replace(/[\u0300-\u036f]/g,'')
    .toLowerCase().replace(/[^a-z0-9\s]/g,'').trim().replace(/\s+/g,' ');
}
const num = (t) => { const m = String(t||'').match(/-?\d+/); return m ? parseInt(m[0],10) : null; };

function parseEquipo(html, equipo) {
  const $ = cheerio.load(html);
  const out = [];

  // Solo jugadores reales: tienen a.jugador con enlace a /jugadores/SLUG
  const filas = $('.elemento_jugador').filter((_, el) =>
    $(el).find('a.jugador[href*="/jugadores/"]').length > 0);

  filas.each((_, el) => {
    const $el = $(el);
    const a = $el.find('a.jugador[href*="/jugadores/"]').first();
    const slug = (a.attr('href')||'').match(/jugadores\/([^/?#]+)/)?.[1];
    if (!slug) return;

    // ID de FutbolFantasy desde la clase jugador-NNNN
    const idMatch = ($el.attr('class')||'').match(/jugador-(\d+)/);
    const ffId = idMatch ? idMatch[1] : null;

    const nombre = a.find('.nombre').text().trim() || a.text().trim();

    // Probabilidad: .prob-N -> "60%"
    const probEl = $el.find('[class*="prob-"]').first();
    const probabilidad = num(probEl.text());   // 0..100

    // Estado / jerarquía: .jerarquia-N -> "Rotación", "Clave", etc.
    const estadoEl = $el.find('[class*="jerarquia-"]').filter((_, e) =>
      $(e).text().trim().length > 0).first();
    const estado = estadoEl.text().trim() || null;

    // Celdas .rival: [local] [vs/@] [rival] [icono casa/fuera]
    // El rival es el 3er equipo (índice 2); el 1º es el propio equipo.
    const celdasRival = $el.find('.rival');
    const rivalTxt = celdasRival.eq(2).text().trim();
    const rival = /^[A-Z]{2,4}$/.test(rivalTxt) ? rivalTxt : null;
    // Local/visitante: el icono lleva alt "Fuera"/"Casa", o plane-icon = fuera
    const iconoLugar = celdasRival.eq(3).find('img');
    const altLugar = (iconoLugar.attr('alt') || '').toLowerCase();
    const srcLugar = (iconoLugar.attr('src') || iconoLugar.attr('data-src') || '');
    const local = altLugar.includes('casa') ? true
                : altLugar.includes('fuera') ? false
                : /plane/.test(srcLugar) ? false : null;

    // Nacionalidad / edad: "28 años"
    const edadTxt = $el.find('.nacionalidad').map((_, e) => $(e).text()).get()
      .find(t => /años/.test(t));
    const edad = edadTxt ? num(edadTxt) : null;

    // Lesión: la clase "lesionado" del contenedor la llevan TODOS (es de
    // plantilla CSS, no una marca real). Solo fiable si hay un icono de estado
    // dentro del jugador. En pretemporada no los hay, así que suele ser false.
    const iconoLesion = $el.find('[class*="lesionado_box"], [class*="sancionado"], [class*="duda_box"]');
    const lesionado = iconoLesion.length > 0;

    out.push({
      slug, ffId,
      nombreNorm: normalizar(nombre),
      equipo,
      probabilidad,
      estado,
      rival, local,
      edad,
      lesionado
    });
  });
  return out;
}

async function main() {
  console.log('== Test de acceso ==');
  const t = await fetch(BASE + 'alaves', { headers: { 'User-Agent': UA } });
  console.log('status:', t.status);
  if (t.status !== 200) {
    writeFileSync('externo.json', JSON.stringify({ format:2, bloqueado:true, status:t.status, porNombre:{} }));
    process.exit(0);
  }

  const jugadores = [];
  const slugsUsados = {};
  for (const equipo of EQUIPOS) {
    try {
      // Probar el slug principal y, si falla, las alternativas conocidas.
      const candidatos = SLUG_ALTERNATIVAS[equipo] || [equipo];
      let res = null, slugOk = null, html = null;
      for (const cand of candidatos) {
        const r = await fetch(BASE + cand, { headers: { 'User-Agent': UA } });
        if (r.ok) {
          const txt = await r.text();
          // Verificar que la página tiene jugadores (no es un 404 con 200)
          if (txt.includes('elemento_jugador')) { res = r; slugOk = cand; html = txt; break; }
        }
        await sleep(400);
      }
      if (!res) { console.error(equipo, '-> NINGÚN slug válido de:', candidatos.join(',')); continue; }
      slugsUsados[equipo] = slugOk;
      const parsed = parseEquipo(html, equipo);
      // Cuántos con probabilidad válida (control de calidad)
      const conProb = parsed.filter(p => p.probabilidad != null && p.probabilidad <= 100).length;
      console.log(`${equipo}: ${parsed.length} jugadores (${conProb} con prob válida)`);
      jugadores.push(...parsed);
    } catch (e) { console.error('Error', equipo, e.message); }
    await sleep(1500);
  }

  // Control de calidad global
  const probsMalas = jugadores.filter(j => j.probabilidad != null && j.probabilidad > 100).length;
  const conEstado = jugadores.filter(j => j.estado).length;
  console.log(`\n== Calidad: ${jugadores.length} jugadores, ${probsMalas} probabilidades fuera de rango, ${conEstado} con estado ==`);

  const salida = {
    format: 2,
    fuente: 'futbolfantasy',
    generatedAt: new Date().toISOString(),
    total: jugadores.length,
    porNombre: Object.fromEntries(jugadores.map(j => [j.nombreNorm, j]))
  };
  writeFileSync('externo.json', JSON.stringify(salida, null, 2));
  console.log('externo.json escrito.');
  console.log('Slugs usados para equipos con alternativas:',
    JSON.stringify(slugsUsados));
}
main();

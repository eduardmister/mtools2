/* ============================================================================
 * MisterTools · Scraper de FutbolFantasy  (GitHub Actions)
 * Selectores verificados sobre el HTML real (jul 2026).
 * Solo lee una web pública. Una pasada al día. No toca Mister.
 * ==========================================================================*/
import * as cheerio from 'cheerio';
import { writeFileSync } from 'fs';

const BASE = 'https://www.futbolfantasy.com/laliga/equipos/';
const EQUIPOS = [
  'alaves','athletic','atletico','barcelona','betis','celta','elche','espanyol',
  'getafe','girona','levante','mallorca','osasuna','rayo-vallecano','real-madrid',
  'real-oviedo','real-sociedad','sevilla','valencia','villarreal'
];
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

    // Rival: tres celdas .rival -> [escudo/ALA] [vs/@] [GET]
    const rivales = $el.find('.rival').map((_, r) => $(r).text().trim()).get();
    const rival = rivales.find(t => /^[A-Z]{2,4}$/.test(t) && t !== 'VS') || null;
    const local = rivales.includes('vs') ? true : (rivales.includes('@') ? false : null);

    // Nacionalidad / edad: "28 años"
    const edadTxt = $el.find('.nacionalidad').map((_, e) => $(e).text()).get()
      .find(t => /años/.test(t));
    const edad = edadTxt ? num(edadTxt) : null;

    // Lesión / sanción por clases del contenedor
    const cls = $el.attr('class') || '';
    const lesionado = /(^|\s)lesionado(\s|$)/.test(cls) &&
                      !/lesionado_box/.test(cls);   // clase real, no icono suelto

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
  for (const equipo of EQUIPOS) {
    try {
      const res = await fetch(BASE + equipo, { headers: { 'User-Agent': UA } });
      if (!res.ok) { console.error(equipo, res.status); continue; }
      const parsed = parseEquipo(await res.text(), equipo);
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
}
main();

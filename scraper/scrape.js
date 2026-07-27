/* ============================================================================
 * MisterTools · Scraper de FutbolFantasy  (corre en GitHub Actions)
 *
 * Lee las páginas de equipo de FutbolFantasy (HTML crudo), extrae por jugador
 * la probabilidad de titularidad, estado, lesión/sanción y datos de balón
 * parado, y genera un externo.json que MisterTools consume.
 *
 * NO toca Mister. Solo lee una web pública. Una pasada al día.
 * ==========================================================================*/
import * as cheerio from 'cheerio';
import { writeFileSync } from 'fs';

const BASE = 'https://www.futbolfantasy.com/laliga/equipos/';
const EQUIPOS = [
  'alaves','athletic','atletico','barcelona','betis','celta','elche','espanyol',
  'getafe','girona','levante','mallorca','osasuna','rayo-vallecano','real-madrid',
  'real-oviedo','real-sociedad','sevilla','valencia','villarreal'
];

const UA = 'Mozilla/5.0 (compatible; MisterToolsBot/1.0; +personal-use)';
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function normalizar(nombre) {
  return (nombre||'').normalize('NFD').replace(/[\u0300-\u036f]/g,'')
    .toLowerCase().replace(/[^a-z0-9\s]/g,'').trim().replace(/\s+/g,' ');
}

// Parseo por jugador. Cada jugador es un enlace /jugadores/SLUG dentro de una
// fila de la alineación que contiene su probabilidad (NN%) y su estado.
function parseEquipo(html, equipo) {
  const $ = cheerio.load(html);
  const out = [];
  const vistos = new Set();
  const ESTADOS = ['Clave','Importante','Rotación','Reserva','Revulsivo'];

  $('a[href*="/jugadores/"]').each((_, el) => {
    const href = $(el).attr('href') || '';
    const m = href.match(/\/jugadores\/([^/?#]+)/);
    if (!m) return;
    const slug = m[1];
    if (vistos.has(slug)) return;

    // Subimos al contenedor de la fila del jugador (el que lleva su %).
    let cont = $(el);
    for (let i = 0; i < 6; i++) {
      cont = cont.parent();
      if (/\d{1,3}%/.test(cont.text())) break;
    }
    const texto = cont.text();
    const prob = (texto.match(/(\d{1,3})%/) || [])[1];
    if (prob === undefined) return;

    vistos.add(slug);
    const html_c = cont.html() || '';
    let estado = null;
    for (const e of ESTADOS) if (texto.includes(e)) { estado = e; break; }

    out.push({
      slug,
      nombreNorm: normalizar(slug.replace(/-/g,' ')),
      equipo,
      probabilidad: parseInt(prob, 10),
      estado,
      lesionado: /lesionado_box/.test(html_c),
      duda: /duda_box/.test(html_c),
      sancionado: /sancionado[AR]?_box/.test(html_c)
    });
  });
  return out;
}

async function main() {
  // --- Test de acceso: probamos UN equipo antes de recorrerlos todos ---
  console.log("== Test de acceso a FutbolFantasy ==");
  try {
    const t = await fetch(BASE + "espanyol", { headers: { "User-Agent": UA } });
    console.log("status de prueba:", t.status);
    if (t.status === 403 || t.status === 429) {
      console.error("BLOQUEADO (" + t.status + "). Las IPs de GitHub Actions no pasan " +
        "el filtro de FutbolFantasy. La opción A no es viable; toca la opción C " +
        "(captura asistida desde tu navegador).");
      const diag = { format: 1, fuente: "futbolfantasy", bloqueado: true,
        status: t.status, generatedAt: new Date().toISOString(), total: 0, porNombre: {} };
      writeFileSync("externo.json", JSON.stringify(diag, null, 2));
      process.exit(0);   // salida limpia: el diagnóstico es el resultado
    }
    console.log("¡Acceso permitido! Procediendo con todos los equipos.");
  } catch (e) {
    console.error("Error de red en el test:", e.message);
    process.exit(1);
  }

  const jugadores = [];
  for (const equipo of EQUIPOS) {
    try {
      const res = await fetch(BASE + equipo, { headers: { 'User-Agent': UA } });
      if (!res.ok) { console.error(equipo, '->', res.status); continue; }
      const html = await res.text();
      const parsed = parseEquipo(html, equipo);
      console.log(equipo, '->', parsed.length, 'jugadores');
      jugadores.push(...parsed);
    } catch (e) {
      console.error('Error en', equipo, e.message);
    }
    await sleep(1500);   // pausa entre equipos, buena vecindad
  }

  const salida = {
    format: 1,
    fuente: 'futbolfantasy',
    generatedAt: new Date().toISOString(),
    total: jugadores.length,
    // Indexado por nombre normalizado para que MisterTools cruce por nombre.
    porNombre: Object.fromEntries(jugadores.map(j => [j.nombreNorm, j]))
  };
  writeFileSync('externo.json', JSON.stringify(salida, null, 2));
  console.log('\nTotal:', jugadores.length, 'jugadores -> externo.json');
}

main();

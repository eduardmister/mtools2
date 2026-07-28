/* Modo diagnóstico: descarga UNA página y vuelca la estructura HTML de la
 * zona de un jugador, para diseñar bien los selectores. */
import * as cheerio from 'cheerio';

const UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36';

const res = await fetch('https://www.futbolfantasy.com/laliga/equipos/alaves', {
  headers: { 'User-Agent': UA }
});
console.log('status:', res.status);
const html = await res.text();
console.log('bytes:', html.length);

const $ = cheerio.load(html);

// Buscar el primer enlace a /jugadores/ que esté en la zona de alineación
const primer = $('a[href*="/jugadores/"]').first();
console.log('\n=== Primer enlace a jugador ===');
console.log('href:', primer.attr('href'));
console.log('clases del enlace:', primer.attr('class'));

// Subir por ancestros mostrando clase y un fragmento de texto
console.log('\n=== Ancestros (clase | nº hijos | texto[0:60]) ===');
let n = primer;
for (let i = 0; i < 8; i++) {
  n = n.parent();
  if (!n.length) break;
  const cls = (n.attr('class') || '(sin clase)').slice(0, 50);
  const tag = n.prop('tagName');
  const txt = n.text().replace(/\s+/g,' ').trim().slice(0, 60);
  console.log(`  [${i}] <${tag}> .${cls} | "${txt}"`);
}

// Buscar contenedores que parezcan "una tarjeta de jugador"
console.log('\n=== Clases candidatas a fila de jugador ===');
const clasesConteo = {};
$('a[href*="/jugadores/"]').each((_, el) => {
  let p = $(el).parent();
  for (let i = 0; i < 5; i++) {
    const c = p.attr('class');
    if (c) c.split(/\s+/).forEach(cl => { clasesConteo[cl] = (clasesConteo[cl]||0)+1; });
    p = p.parent();
  }
});
Object.entries(clasesConteo).sort((a,b)=>b[1]-a[1]).slice(0,20)
  .forEach(([c,n]) => console.log(`  ${n}x  .${c}`));

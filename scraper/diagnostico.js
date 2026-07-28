import * as cheerio from 'cheerio';
const UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36';
const res = await fetch('https://www.futbolfantasy.com/laliga/equipos/barcelona', { headers: { 'User-Agent': UA } });
const $ = cheerio.load(await res.text());

const filas = $('.elemento_jugador').filter((_, el) => $(el).find('a.jugador[href*="/jugadores/"]').length > 0);
console.log('jugadores:', filas.length);

filas.slice(0, 2).each((i, el) => {
  const $el = $(el);
  const nombre = $el.find('a.jugador .nombre').text().trim();
  console.log('\n===== ' + nombre + ' =====');

  // 1) ¿Dónde está "lesionado"? Ver clases del contenedor y de padres
  console.log('clase del .elemento_jugador:', $el.attr('class'));
  console.log('¿tiene .lesionado dentro?:', $el.find('.lesionado').length);
  console.log('¿algún padre tiene lesionado?:',
    $el.parents().filter((_,p)=>/lesionado/.test($(p).attr('class')||'')).length);
  // buscar iconos de lesión/sanción DENTRO del jugador
  const iconos = $el.find('[class*="lesion"], [class*="sancion"], [class*="duda"]');
  console.log('iconos de estado dentro:', iconos.map((_,e)=>$(e).attr('class')).get().join(' | ') || 'ninguno');

  // 2) Celdas .rival: volcar todas con su HTML (para ver escudos/texto)
  console.log('--- celdas .rival ---');
  $el.find('.rival').each((j, r) => {
    const $r = $(r);
    const img = $r.find('img');
    const alt = img.attr('alt') || img.attr('title') || '';
    const src = (img.attr('src')||img.attr('data-src')||'').split('/').pop();
    console.log(`  [${j}] txt="${$r.text().trim()}" imgAlt="${alt}" imgSrc="${src}"`);
  });
});

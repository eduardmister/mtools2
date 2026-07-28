import * as cheerio from 'cheerio';
const UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36';
const res = await fetch('https://www.futbolfantasy.com/laliga/equipos/alaves', { headers: { 'User-Agent': UA } });
console.log('status:', res.status);
const html = await res.text();
const $ = cheerio.load(html);

const elems = $('.elemento_jugador');
console.log('nº de .elemento_jugador:', elems.length);

// Volcar el HTML de los 3 primeros, formateado y recortado
elems.slice(0, 3).each((i, el) => {
  console.log('\n========== JUGADOR ' + i + ' ==========');
  const $el = $(el);
  // enlace y slug
  const a = $el.find('a[href*="/jugadores/"]').first();
  console.log('slug:', (a.attr('href')||'').match(/jugadores\/([^/?#]+)/)?.[1]);
  console.log('clases del contenedor:', $el.attr('class'));
  // HTML interno recortado
  let inner = $el.html().replace(/\s+/g, ' ').replace(/> </g, '>\n<');
  console.log('--- HTML interno (recortado a 1500 chars) ---');
  console.log(inner.slice(0, 1500));
  // texto limpio
  console.log('--- texto ---');
  console.log($el.text().replace(/\s+/g,' ').trim().slice(0, 200));
});

// ¿Dónde está el % de probabilidad? Buscar clases con "porcent" o similar
console.log('\n=== Elementos con % ===');
$('[class*="porc"], [class*="prob"], [class*="titular"]').slice(0,5).each((_, el) => {
  console.log('  .' + $(el).attr('class'), '->', $(el).text().trim().slice(0,20));
});

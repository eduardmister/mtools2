import * as cheerio from 'cheerio';
const UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36';
const res = await fetch('https://www.futbolfantasy.com/laliga/equipos/alaves', { headers: { 'User-Agent': UA } });
const $ = cheerio.load(await res.text());

// Solo jugadores reales: los que tienen slug en un enlace jugadores/SLUG
const reales = $('.elemento_jugador').filter((_, el) =>
  $(el).find('a.jugador[href*="/jugadores/"]').length > 0);
console.log('jugadores reales:', reales.length);

reales.slice(0, 2).each((i, el) => {
  const $el = $(el);
  console.log('\n===== JUGADOR', i, '=====');
  console.log('clases:', $el.attr('class'));
  const a = $el.find('a.jugador[href*="/jugadores/"]').first();
  console.log('slug:', (a.attr('href')||'').match(/jugadores\/([^/?#]+)/)?.[1]);
  console.log('nombre visible:', a.text().replace(/\s+/g,' ').trim());

  // La zona .datos con las columnas
  const datos = $el.find('.datos').first();
  console.log('\n--- .datos innerHTML (a 2500) ---');
  console.log((datos.html()||'(no encontrado)').replace(/\s+/g,' ').replace(/></g,'>\n<').slice(0,2500));
});

// Buscar la columna de probabilidad concreta
console.log('\n=== .datos-col dentro del primer jugador ===');
const j0 = reales.first();
j0.find('.datos-col, [class*="prob"], [class*="estado"], [class*="dato_"]').each((_, el) => {
  const c = $(el).attr('class');
  const t = $(el).text().replace(/\s+/g,' ').trim().slice(0,30);
  const title = $(el).attr('title') || $(el).find('[title]').attr('title') || '';
  console.log('  .' + c + ' | txt="' + t + '"' + (title?' | title="'+title+'"':''));
});

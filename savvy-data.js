/* Savvy Renter — data loader
 * ---------------------------------------------------------------------------
 * Fetches the small JSON files published at data.savvyrenter.co.uk.
 *
 * Nothing about the user is sent anywhere. A postcode typed into a page is
 * used to work out which file to ask for and never leaves the browser beyond
 * that: the request is for a file named after the outcode, the same file
 * everyone in that outcode asks for.
 *
 * Usage:
 *     const place = await SavvyData.postcode('PL4 6JJ');
 *     const rents = await SavvyData.rents(place.lad);
 *     const lha   = await SavvyData.lha();
 */
const SavvyData = (() => {

  // The one place the address lives. Change this and everything follows.
  const BASE = 'https://data.savvyrenter.co.uk/v1/';

  // Files fetched once per tab. They never change while someone is looking at
  // the page, so checking three flats in a row costs one request, not three.
  const cache = new Map();

  // One attempt. 'how' is the browser cache mode: the first go is happy to use
  // a stored copy, the second insists on a fresh one.
  function attempt(path, how) {
    return fetch(BASE + path, { cache: how }).then(r => {
      if (r.status === 404) return null;            // asked for something that isn't there
      if (!r.ok) throw new Error('Could not load ' + path + ' (' + r.status + ')');
      return r.json();
    });
  }

  function get(path) {
    if (cache.has(path)) return cache.get(path);
    // If the stored copy is bad — held over from a spell when the data host was
    // down or misconfigured — the browser would go on serving it for as long as
    // it kept it, and the page would look broken to someone whose connection is
    // perfectly fine. So a failure is tried once more with the cache bypassed,
    // and only a second failure is reported.
    const p = attempt(path, 'default')
      .catch(() => attempt(path, 'reload'))
      .catch(err => { cache.delete(path); throw err; });   // let a later retry work
    cache.set(path, p);
    return p;
  }

  // ---- postcodes ---------------------------------------------------------
  // Accepts anything a person might type: "pl4 6jj", "PL46JJ", " PL4  6JJ ".
  // The last three characters of a UK postcode are always the inward code, so
  // the split is reliable without needing to know the outcode's shape.
  function tidy(raw) {
    const s = String(raw || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
    if (s.length < 5 || s.length > 7) return null;
    return { outcode: s.slice(0, -3), unit: s.slice(-3), full: s.slice(0, -3) + ' ' + s.slice(-3) };
  }

  async function postcode(raw) {
    const t = tidy(raw);
    if (!t) return { ok: false, reason: 'format', message: 'That does not look like a full UK postcode.' };

    let file;
    try {
      file = await get('outcodes/' + t.outcode + '.json');
    } catch (e) {
      return { ok: false, reason: 'offline', message: 'Could not reach the data just now. Check your connection and try again.' };
    }
    if (!file) return { ok: false, reason: 'unknown', message: 'No postcodes found for ' + t.outcode + '.' };

    const row = file.p[t.unit];
    if (!row) return { ok: false, reason: 'unknown', message: t.full + ' was not found. It may be a closed postcode, or a typo.' };

    return {
      ok: true,
      postcode: t.full,
      outcode: t.outcode,
      lad: file.lad[row[0]],        // local authority code — the key for rents
      pfa: file.pfa[row[1]],        // police force area code
      lat: row[2],
      lon: row[3]
    };
  }

  // ---- the rent index ----------------------------------------------------
  const rents = code => code ? get('rents/' + code + '.json') : Promise.resolve(null);

  // ---- housing allowance -------------------------------------------------
  const lha = () => get('lha-rates.json');

  // Names are normalised in the rates file: uppercase, "and" spelled out.
  const brmaKey = name => String(name || '').toUpperCase().replace(/&/g, 'AND').replace(/\s+/g, ' ').trim();

  async function lhaFor(brmaName, year) {
    const all = await lha();
    const b = all.brma[brmaKey(brmaName)];
    if (!b) return null;
    const y = year || all.years[all.years.length - 1];
    const r = b.rates[y];
    if (!r) return null;
    return { name: b.name, nation: b.nation, year: y,
             shared: r[0], bed1: r[1], bed2: r[2], bed3: r[3], bed4: r[4] };
  }

  // ---- reading the rent series ------------------------------------------
  // beds: 0 = any size, 1..4 = that many bedrooms. Returns null where ONS
  // published no figure, rather than guessing one.
  const COL = { 0: 1, 1: 2, 2: 3, 3: 4, 4: 5 };

  function atMonth(series, month, beds = 0) {
    if (!series) return null;
    const col = COL[beds];
    const row = month
      ? series.months.find(m => m[0] === month)
      : [...series.months].reverse().find(m => m[col] != null);
    return row ? { month: row[0], rent: row[col] } : null;
  }

  // How much the rent in an area has moved over a period, as a figure and a
  // percentage. Give it the number of years back to compare with.
  function change(series, yearsBack = 1, beds = 0) {
    const now = atMonth(series, null, beds);
    if (!now) return null;
    const [y, m] = now.month.split('-').map(Number);
    const thenMonth = (y - yearsBack) + '-' + String(m).padStart(2, '0');
    const then = atMonth(series, thenMonth, beds);
    if (!then || !then.rent) return null;
    return {
      from: then.month, to: now.month,
      wasRent: then.rent, nowRent: now.rent,
      difference: now.rent - then.rent,
      percent: Math.round(((now.rent - then.rent) / then.rent) * 1000) / 10
    };
  }

  return { BASE, postcode, rents, lha, lhaFor, brmaKey, atMonth, change, tidy };
})();

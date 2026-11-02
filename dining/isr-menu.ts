// Copies UIUC's ISR dining hall menus into one file the app reads (src/dining.ts): each station's menu at
// breakfast, lunch and dinner for the last week and the next day (Build Your Own's salad bar, deli, cereal and
// so on under every meal), with calories, protein, carbs and fat from each food's nutrition label on the dining
// service's EatSmart site.
// GitHub Actions runs it twice a day in the public releases repository, which publishes the file
// (scripts/dining-workflow.yml, put there by scripts/publish-dining.ts). Past days are kept from the last file
// instead of fetched again, and each label is fetched once (by name and serving), so a run makes about 100
// requests to the site, one at a time.
// Run with: node scripts/isr-menu.ts <the last file, or a missing path> <output file> [--fresh: fetch every label again]
import { existsSync, readFileSync, writeFileSync } from "node:fs";
// Only types: Node drops this line when it runs the script, so the script also runs on its own.
import type { DiningFood, DiningGroup, DiningMeal, DiningMenu, DiningStation } from "../src/dining.ts";

const SITE = "https://eatsmart.housing.illinois.edu/NetNutrition/46";
const ISR = 11;                 // the dining center's number on the site
const DAYS_BACK = 7, DAYS_AHEAD = 1;

// Reading the site's HTML.
const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: "\"", apos: "'", nbsp: " " };
export const decode = (s: string) => s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) =>
  e[0] === "#" ? String.fromCodePoint(e[1].toLowerCase() === "x" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10)) : ENTITIES[e.toLowerCase()] ?? m);
export const textOf = (html: string) => decode(html.replace(/<[^>]*>/g, " ")).replace(/\s+/g, " ").trim();

// The stations in the dining center: [number, name].
export function parseStations(html: string): { oid: number; name: string }[] {
  return [...html.matchAll(/childUnitsSelectUnit\((\d+)\);"?>([^<]+)</g)].map(m => ({ oid: Number(m[1]), name: textOf(m[2]) }));
}

const MONTHS = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];
// "Sunday, November 1, 2026" → "2026-11-01".
export function parseDate(text: string): string | null {
  const m = /([a-z]+)\s+(\d{1,2}),\s*(\d{4})/i.exec(text), month = m ? MONTHS.indexOf(m[1].toLowerCase()) : -1;
  return m && month >= 0 ? `${m[3]}-${String(month + 1).padStart(2, "0")}-${m[2].padStart(2, "0")}` : null;
}
const mealOf = (name: string): DiningMeal | null => {
  const n = name.toLowerCase();
  return n.includes("breakfast") || n.includes("brunch") ? "breakfast" : n.includes("lunch") ? "lunch" : n.includes("dinner") ? "dinner" : null;
};

// A station's menus, by date: a meal ("Lunch"), or something else ("Salad Bar", "Late Night") with meal null.
export interface MenuLink { date: string; meal: DiningMeal | null; name: string; oid: number }
export function parseMenuList(html: string): MenuLink[] {
  return [...html.matchAll(/<header[^>]*>([^<]+)<\/header>([\s\S]*?)<\/section>/g)].flatMap(day => {
    const date = parseDate(textOf(day[1]));
    if(!date) return [];
    return [...day[2].matchAll(/menuListSelectMenu\((\d+)\);"?>([^<]+)</g)].map(m => {
      const name = textOf(m[2]);
      return { date, meal: mealOf(name), name, oid: Number(m[1]) };
    });
  });
}

// The menus to copy and the meals each belongs to. A station with no meal menus that day (Build Your Own:
// "Salad Bar", "Cereal", "Deli & Bagel Bar") serves them all day, so they go under every meal. Anything else
// that isn't a meal ("Late Night" at a station that also has lunch and dinner) is left out.
export function menusToCopy(links: MenuLink[]): { date: string; meals: DiningMeal[]; name: string; oid: number }[] {
  const hasMeals = new Set(links.filter(l => l.meal).map(l => l.date));
  return links.flatMap(l => l.meal ? [{ date: l.date, meals: [l.meal], name: l.name, oid: l.oid }]
    : hasMeals.has(l.date) ? [] : [{ date: l.date, meals: [...ALL_DAY], name: l.name, oid: l.oid }]);
}
const ALL_DAY: DiningMeal[] = ["breakfast", "lunch", "dinner"];

// A menu's foods, in its parts ("Entrees", "Starches"): each food's label number, name and serving.
export interface MenuItem { oid: number; name: string; serving: string }
export function parseItems(html: string): { name: string; items: MenuItem[] }[] {
  const groups: { name: string; items: MenuItem[] }[] = [];
  for(const row of html.split(/<tr\b/).slice(1)){
    if(row.includes("cbo_nn_itemGroupRow")){ groups.push({ name: textOf(/<div role='button'>([\s\S]*?)<i\b/.exec(row)?.[1] ?? row), items: [] }); continue; }
    const m = /getItemNutritionLabelOnClick\(event,\s*(\d+)\)[\s\S]*?class='cbo_nn_itemHover'>([^<]+)</.exec(row);
    if(!m) continue;
    const cells = [...row.matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/g)].map(c => c[1]);
    if(!groups.length) groups.push({ name: "Menu", items: [] });
    groups[groups.length - 1].items.push({ oid: Number(m[1]), name: textOf(m[2]), serving: textOf(cells[2] ?? "") });
  }
  return groups.filter(g => g.items.length);
}

// A nutrition label's numbers for one serving, or null without calories. "< 1g" counts as half a gram. A few
// "foods" are the kitchen's bulk containers (a gallon of chutney): over 2,000 kcal, they're left out too.
export function parseLabel(html: string): Omit<DiningFood, "name" | "serving"> | null {
  const text = textOf(html);
  const amount = (label: string, max: number) => {
    const m = new RegExp(`${label}\\s+(<\\s*)?(\\d+(?:\\.\\d+)?)\\s*g\\b`, "i").exec(text);
    if(!m) return undefined;
    const n = m[1] ? Number(m[2]) / 2 : Number(m[2]);
    return n <= max ? Math.round(n * 10) / 10 : undefined;
  };
  const kcal = Number(/Calories\s+(\d+(?:\.\d+)?)/i.exec(text)?.[1] ?? NaN);
  if(!Number.isFinite(kcal) || kcal > 2000) return null;
  const grams = Number(/Serving Size:[^(]*\((\d+(?:\.\d+)?)\s*g\)/i.exec(text)?.[1] ?? NaN);
  const food: Omit<DiningFood, "name" | "serving"> = { kcal: Math.round(kcal), protein: amount("Protein", 500) ?? 0 };
  const carbs = amount("Total Carbohydrate", 1000), fat = amount("Total Fat", 1000);
  if(Number.isFinite(grams) && grams > 0) food.grams = Math.round(grams);
  if(carbs !== undefined) food.carbs = carbs;
  if(fat !== undefined) food.fat = fat;
  return food;
}

// Talking to the site, one request at a time: it keeps which page you're on in a session cookie.
let cookies = "";
const pause = () => new Promise(r => setTimeout(r, 150));
async function request(path: string, form?: Record<string, number>): Promise<string> {
  await pause();
  const res = await fetch(`${SITE}${path}`, {
    method: form ? "POST" : "GET",
    redirect: "manual",   // the first page sets the cookie on a redirect, which fetch would otherwise drop
    headers: { "User-Agent": "IronLedger-menus/1.0 (+https://github.com/uranitonium/iron-ledger-releases)", "X-Requested-With": "XMLHttpRequest", Cookie: cookies,
      "Accept-Language": "en-US",   // Node's own "*" gives a start-up error on this site
      ...(form ? { "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8" } : {}) },
    body: form ? new URLSearchParams(Object.entries(form).map(([k, v]) => [k, String(v)])) : undefined,
  });
  const set = res.headers.getSetCookie().map(c => c.split(";")[0]);
  if(set.length){
    const jar = new Map(cookies.split("; ").filter(Boolean).map(c => [c.split("=")[0], c] as const));
    for(const c of set) jar.set(c.split("=")[0], c);
    cookies = [...jar.values()].join("; ");
  }
  if(!res.ok && !(res.status >= 300 && res.status < 400)) throw new Error(`${path || "/"}: HTTP ${res.status}`);
  return res.text();
}
const panel = (json: string, id: string) => (JSON.parse(json) as { panels: { id: string; html: string }[] }).panels.find(p => p.id === id)?.html ?? "";

const localDate = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const addDays = (date: string, n: number) => { const d = new Date(date + "T12:00:00"); d.setDate(d.getDate() + n); return localDate(d); };
const keyOf = (name: string, serving: string) => `${name.toLowerCase()}|${serving.toLowerCase()}`;

// While fetching, menus name each food by a key (its name and serving) instead of its place in the list.
type Keyed = Record<string, Partial<Record<DiningMeal, { name: string; groups: { name: string; foods: string[] }[] }[]>>>;

// The menus for `today` (in Champaign: run with TZ=America/Chicago): fetched for the days not in `last`, and for
// today and later; past days come from `last`. Each food's label is fetched only if `last` doesn't have it.
// `fresh` fetches everything again.
export async function fetchMenus(last: DiningMenu | null, today: string, fresh: boolean): Promise<DiningMenu> {
  const from = addDays(today, -DAYS_BACK), to = addDays(today, DAYS_AHEAD);
  const known = new Map<string, DiningFood>(fresh ? [] : (last?.foods ?? []).map(f => [keyOf(f.name, f.serving), f]));
  const days: Keyed = {};
  for(const [date, meals] of Object.entries(fresh ? {} : last?.days ?? {})){
    if(date < from || date >= today) continue;
    for(const meal of Object.keys(meals) as DiningMeal[]){
      days[date] ??= {};
      days[date][meal] = (meals[meal] ?? []).map(s => ({ name: s.name, groups: s.groups.map(g => ({ name: g.name, foods: g.foods.map(i => {
        const f = last!.foods[i], key = keyOf(f.name, f.serving);
        known.set(key, f);
        return key;
      }) })) }));
    }
  }
  const wanted = (date: string) => date >= from && date <= to && (date >= today || !days[date]);

  await request("");
  const stations = parseStations(panel(await request("/Unit/SelectUnitFromUnitsList", { unitOid: ISR }), "childUnitsPanel"));
  if(!stations.length) throw new Error("No stations found: the EatSmart site may have changed.");
  let labels = 0;
  for(const station of stations){
    const menus = menusToCopy(parseMenuList(panel(await request("/Unit/SelectUnitFromChildUnitsList", { unitOid: station.oid }), "menuPanel")).filter(m => wanted(m.date)));
    for(const menu of menus){
      const groups: { name: string; foods: string[] }[] = [];
      const parts = parseItems(panel(await request("/Menu/SelectMenu", { menuOid: menu.oid }), "itemPanel"));
      for(const g of parts){
        const keys: string[] = [];
        for(const item of g.items){
          const key = keyOf(item.name, item.serving);
          if(!known.has(key)){
            const numbers = parseLabel(await request("/NutritionDetail/ShowItemNutritionLabel", { detailOid: item.oid }));
            labels++;
            if(!numbers) continue;   // no label: nothing to log it with
            known.set(key, { name: item.name, serving: item.serving, ...numbers });
          }
          if(!keys.includes(key)) keys.push(key);
        }
        if(keys.length) groups.push({ name: partName(menu, parts.length, g.name), foods: keys });
      }
      if(groups.length) for(const meal of menu.meals){
        const list = ((days[menu.date] ??= {})[meal] ??= []);
        const at = list.find(s => s.name === station.name);
        if(at) at.groups.push(...groups); else list.push({ name: station.name, groups: [...groups] });
      }
    }
  }
  console.log(`isr-menu: ${stations.length} stations, ${labels} labels fetched.`);
  return numbered(days, known);
}

// A part of an all-day menu says which menu it's from: "Salad Bar · Proteins", or just "Cereal" when the menu
// has one part. A meal's parts keep their own names ("Entrees").
export const partName = (menu: { meals: DiningMeal[]; name: string }, parts: number, group: string) =>
  menu.meals.length === 1 ? group : parts === 1 ? menu.name : `${menu.name} · ${group}`;

// The file lists each food once, sorted, and the menus point into it. Sorted foods and dates keep the file the
// same when nothing changed, so it's only published when something did.
export function numbered(days: Keyed, known: Map<string, DiningFood>): DiningMenu {
  const keys = [...new Set(Object.values(days).flatMap(meals => Object.values(meals).flatMap(list => (list ?? []).flatMap(s => s.groups.flatMap(g => g.foods)))))].sort();
  const index = new Map(keys.map((k, i) => [k, i]));
  const out: DiningMenu = { hall: "ISR", foods: keys.map(k => known.get(k)!), days: {} };
  for(const date of Object.keys(days).sort()){
    out.days[date] = {};
    for(const meal of ["breakfast", "lunch", "dinner"] as DiningMeal[]){
      const list = days[date][meal];
      if(list) out.days[date][meal] = list.map((s): DiningStation => ({ name: s.name, groups: s.groups.map((g): DiningGroup => ({ name: g.name, foods: g.foods.map(k => index.get(k)!) })) }));
    }
  }
  return out;
}

if(import.meta.main){
  const [lastPath, outPath] = process.argv.slice(2).filter(a => !a.startsWith("--"));
  if(!lastPath || !outPath) throw new Error("Usage: node scripts/isr-menu.ts <last file> <output file> [--fresh]");
  const last = existsSync(lastPath) ? JSON.parse(readFileSync(lastPath, "utf8")) as DiningMenu : null;
  const menu = await fetchMenus(last, localDate(new Date()), process.argv.includes("--fresh"));
  writeFileSync(outPath, JSON.stringify(menu) + "\n");
  console.log(`isr-menu: ${Object.keys(menu.days).length} days, ${menu.foods.length} foods, ${Math.round(JSON.stringify(menu).length / 1024)} kB.`);
}

import type { ChatSection, ConversationSummary } from "../../api/chat";

// Chat bawaan sebuah divisi (v0.6). Jenis "division" dari inti; divisionId ikut diperiksa supaya
// chat divisi tetap dikenali kalau inti mengirim jenis lain.
export function isDivisionChat(c: ConversationSummary): boolean {
  return c.kind === "division" || !!c.divisionId;
}

// Departemen pemilik percakapan: teamId untuk chat divisi, cakupan untuk channel departemen.
function teamOf(c: ConversationSummary): string | null {
  if (isDivisionChat(c)) return c.teamId ?? (c.scope?.kind === "team" ? c.scope.id : null);
  return c.scope?.kind === "team" ? c.scope.id : null;
}

const active = (c: ConversationSummary) => !c.archived && !c.former;

// Urutan bagian Departemen: chat divisi aktif tepat di bawah channel departemennya, urut nama
// supaya posisinya tetap (tidak melompat setiap ada pesan baru). Channel lain mengikuti urutan
// inti. Chat divisi yang diarsipkan atau sudah bukan anggota tetap di akhir bagian, sama seperti
// percakapan redup lain. Chat divisi tanpa channel departemen di daftar juga tetap di tempatnya.
export function orderDivisionChats(list: ConversationSummary[]): ConversationSummary[] {
  const byTeam = new Map<string, ConversationSummary[]>();
  for (const c of list) {
    const team = teamOf(c);
    if (!isDivisionChat(c) || !active(c) || !team) continue;
    byTeam.set(team, [...(byTeam.get(team) ?? []), c]);
  }
  if (byTeam.size === 0) return list;

  // Channel departemen yang menjadi induk: channel aktif terakhir dari departemen itu, atau
  // channel terakhirnya kalau semuanya redup.
  const parent = new Map<string, string>();
  for (const c of list) {
    const team = teamOf(c);
    if (isDivisionChat(c) || !team || !byTeam.has(team)) continue;
    const current = list.find((x) => x.id === parent.get(team));
    if (!current || active(c) || !active(current)) parent.set(team, c.id);
  }

  const placed = new Set<string>();
  for (const [team, rows] of byTeam) {
    if (!parent.has(team)) continue;
    rows.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));
    rows.forEach((r) => placed.add(r.id));
  }

  const out: ConversationSummary[] = [];
  for (const c of list) {
    if (placed.has(c.id)) continue;
    out.push(c);
    const team = teamOf(c);
    if (team && parent.get(team) === c.id) out.push(...(byTeam.get(team) ?? []));
  }
  return out;
}

// Kelompok per bagian dengan bagian Departemen yang sudah diurutkan.
export function withDivisionOrder(
  groups: Record<ChatSection, ConversationSummary[]>,
): Record<ChatSection, ConversationSummary[]> {
  return { ...groups, departemen: orderDivisionChats(groups.departemen) };
}

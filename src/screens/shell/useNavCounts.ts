// Angka "yang menunggu Anda" untuk menu sidebar. Setiap sumber dimuat sendiri,
// jadi satu sumber yang gagal hanya membuat angkanya nol. Dimuat ulang saat
// event dari Rust datang, saat jendela kembali aktif, dan lewat polling cadangan.
import { useEffect, useState } from "react";
import { subscribeFeature } from "../../api";
import { boardApi, subscribeBoard } from "../../api/board";
import { chatApi, subscribeChat } from "../../api/chat";
import { orgApi, subscribeOrg } from "../../api/org";
import { signingApi } from "../../api/signing";
import { todayIso } from "../board/format";
import { boardDue, chatUnread, joinPending, signWaiting } from "./navCounts";

export type NavCounts = { chat: number; board: number; sign: number; org: number };

// Cadangan kalau event terlewat. Juga yang membuat angka Board ikut berganti
// hari: today dihitung ulang di setiap muat, jadi task yang tenggatnya besok
// masuk hitungan paling lambat 30 detik setelah tengah malam.
export const NAV_COUNTS_POLL_MS = 30_000;

type Unsubscribe = () => void;

const loadChat = async () => chatUnread(await chatApi.overview());
const loadBoard = async () => boardDue(await boardApi.myTasks(), todayIso());
const loadSign = async () => signWaiting(await signingApi.overview());
const subscribeSign = (handler: () => void): Unsubscribe => subscribeFeature("sign", handler);

// TITIK SAMBUNG (D4): agen B membuat hook sendiri untuk jumlah permintaan
// bergabung. Saat cabang digabung, pakai satu saja: ganti loadOrg dan
// subscribeOrg di bawah dengan sumber milik B, atau baca angka dari hook B di
// useNavCounts dan hapus baris useCount untuk org.
const loadOrg = async () => joinPending(await orgApi.overview());

function useCount(load: () => Promise<number>, subscribe: (handler: () => void) => Unsubscribe): number {
  const [count, setCount] = useState(0);

  useEffect(() => {
    let alive = true;
    let seq = 0;
    const reload = async () => {
      const mine = ++seq;
      let next = 0;
      try {
        next = await load();
      } catch {
        // Gagal dibaca: angka tidak ditampilkan. Layar fiturnya sendiri yang menjelaskan error.
        next = 0;
      }
      if (alive && mine === seq) setCount(next);
    };

    void reload();
    let stop: Unsubscribe = () => {};
    try {
      stop = subscribe(() => void reload());
    } catch {
      // Tanpa event: polling dan fokus jendela tetap memuat ulang.
    }
    const timer = window.setInterval(() => void reload(), NAV_COUNTS_POLL_MS);
    const onFocus = () => void reload();
    window.addEventListener("focus", onFocus);
    return () => {
      alive = false;
      stop();
      window.clearInterval(timer);
      window.removeEventListener("focus", onFocus);
    };
  }, [load, subscribe]);

  return count;
}

export function useNavCounts(): NavCounts {
  const chat = useCount(loadChat, subscribeChat);
  const board = useCount(loadBoard, subscribeBoard);
  const sign = useCount(loadSign, subscribeSign);
  const org = useCount(loadOrg, subscribeOrg);
  return { chat, board, sign, org };
}

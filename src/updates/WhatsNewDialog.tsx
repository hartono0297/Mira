import { Dialog, DialogClose } from "../components/Dialog";
import { Markdown } from "./Markdown";
import { useUpdates } from "./UpdateContext";
import "./updates.css";

// Catatan "Yang baru" untuk versi yang terpasang. Tampil sekali setelah diperbarui,
// dan bisa dibuka lagi dari Pengaturan > Tentang dan pembaruan.
export function WhatsNewDialog() {
  const { whatsNew } = useUpdates();
  if (!whatsNew.version || !whatsNew.notes) return null;

  return (
    <Dialog
      open={whatsNew.open}
      onOpenChange={(open) => {
        if (!open) whatsNew.close();
      }}
      title={`Yang baru di Mira ${whatsNew.version}`}
    >
      <Markdown source={whatsNew.notes} />
      <div className="dlg-actions">
        <DialogClose asChild>
          <button type="button" className="btn">
            Tutup
          </button>
        </DialogClose>
      </div>
    </Dialog>
  );
}

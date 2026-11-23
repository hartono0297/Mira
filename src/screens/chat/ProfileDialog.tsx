import type { Person } from "../../api/chat";
import { Dialog } from "../../components/Dialog";

// KONTRAK (diisi sesi Orang): profil singkat seseorang dari orgApi.people().
// person null: dialog tertutup.
export type ProfileDialogProps = {
  person: Person | null;
  onOpenChange: (open: boolean) => void;
};

export function ProfileDialog({ person, onOpenChange }: ProfileDialogProps) {
  return (
    <Dialog open={person !== null} onOpenChange={onOpenChange} title={person?.name ?? ""}>
      {null}
    </Dialog>
  );
}

import logoLight from "../assets/logo.svg";
import logoDark from "../assets/logo-gelap.svg";
import { useTheme } from "../theme/ThemeProvider";

// Logo sementara dari design/. Teks "Mira" selalu ada di sebelahnya, jadi gambar ini dekoratif.
export function Logo({ size = 24 }: { size?: number }) {
  const { resolved } = useTheme();
  return (
    <img
      src={resolved === "dark" ? logoDark : logoLight}
      width={size}
      height={size}
      alt=""
      aria-hidden="true"
      draggable={false}
    />
  );
}

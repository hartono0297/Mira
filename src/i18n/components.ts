import { defineText } from "./core";
import firewallEn from "./components-firewall.en";
import firewallId from "./components-firewall.id";
import menuEn from "./components-menu.en";
import menuId from "./components-menu.id";
import pdfEn from "./components-pdf.en";
import pdfId from "./components-pdf.id";
import en from "./components.en";
import id from "./components.id";

export const COMPONENTS_TEXT = defineText(id, en);
export const MENU_TEXT = defineText(menuId, menuEn);
export const FIREWALL_TEXT = defineText(firewallId, firewallEn);
export const PDF_TEXT = defineText(pdfId, pdfEn);

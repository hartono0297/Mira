// Objek teks layar Kalender yang mengikuti bahasa aktif.
import calendarEn from "./calendar.en";
import calendarId from "./calendar.id";
import { defineText } from "./core";

export const CAL_TEXT = defineText(calendarId, calendarEn);

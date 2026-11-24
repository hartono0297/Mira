import { defineText } from "./core";
import en from "./org.en";
import id from "./org.id";
import usersEn from "./org-users.en";
import usersId from "./org-users.id";

export const ORG_TEXT = defineText(id, en);
export const USERS_TEXT = defineText(usersId, usersEn);

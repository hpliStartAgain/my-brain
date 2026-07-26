import type { ClassValue } from "@quartz-community/types";

export function classNames(...classes: ClassValue[]): string {
  return classes.flat().filter(Boolean).join(" ");
}

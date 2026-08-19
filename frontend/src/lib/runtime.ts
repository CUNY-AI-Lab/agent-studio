import { z } from 'zod';

const stringSchema = z.string();
const numberSchema = z.number();
const booleanSchema = z.boolean();
const functionSchema = z.function();

/** Parse browser-bound primitive values without weakening the caller's evidence. */
export function isString<T>(value: T): value is Extract<T, string> {
  return stringSchema.safeParse(value).success;
}

export function isNumber<T>(value: T): value is Extract<T, number> {
  return numberSchema.safeParse(value).success;
}

export function isBoolean<T>(value: T): value is Extract<T, boolean> {
  return booleanSchema.safeParse(value).success;
}

export function isFunction<T>(value: T): value is Extract<T, (...args: never[]) => void> {
  return functionSchema.safeParse(value).success;
}

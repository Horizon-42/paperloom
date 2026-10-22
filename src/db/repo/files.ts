// files 表：PDF 二进制，主键为 SHA-256
import { db } from "@/db/schema";
import type { FileRecord } from "@/types/models";

export function getFile(hash: string): Promise<FileRecord | undefined> {
  return db.files.get(hash);
}

export async function hasFile(hash: string): Promise<boolean> {
  return (await db.files.where("hash").equals(hash).count()) > 0;
}

export async function putFile(record: FileRecord): Promise<void> {
  await db.files.put(record);
}

export async function deleteFile(hash: string): Promise<void> {
  await db.files.delete(hash);
}

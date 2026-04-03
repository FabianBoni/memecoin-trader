"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { resetAllPaperWhales, resetAllWhales, resetPaperWhale } from "../../src/dashboard/data";

export async function resetPaperWhaleAction(formData: FormData) {
  const whaleAddress = String(formData.get("whaleAddress") ?? "").trim();
  if (!whaleAddress) {
    redirect("/?message=missing-whale");
  }

  resetPaperWhale(whaleAddress);
  revalidatePath("/");
  revalidatePath(`/whales/${whaleAddress}`);
  redirect("/?message=paper-whale-reset");
}

export async function resetAllPaperWhalesAction() {
  resetAllPaperWhales();
  revalidatePath("/");
  redirect("/?message=paper-all-reset");
}

export async function resetAllWhalesAction() {
  resetAllWhales();
  revalidatePath("/");
  redirect("/?message=whales-all-reset");
}
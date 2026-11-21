import { useMutation } from "@tanstack/react-query";
import { Trash2 } from "lucide-react";
import { useState } from "react";

import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";

// A trash button that asks for confirmation before running `remove`.
export function ConfirmDelete({
  label,
  question,
  remove,
  onDeleted,
  variant = "ghost",
  size = "icon",
  disabled = false,
}: {
  label: string;
  question: string;
  remove: () => Promise<unknown>;
  onDeleted: () => void;
  variant?: "ghost" | "outline";
  size?: "icon" | "icon-xs" | "icon-sm";
  // For when the question cannot be answered yet, for instance while the numbers in it are loading.
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const mutation = useMutation({
    mutationFn: remove,
    onSuccess: () => {
      setOpen(false);
      onDeleted();
    },
  });
  return (
    <>
      <Button
        variant={variant}
        size={size}
        aria-label={label}
        title={label}
        disabled={disabled}
        onClick={() => setOpen(true)}
      >
        <Trash2 />
      </Button>
      <AlertDialog
        open={open}
        onOpenChange={(next) => {
          setOpen(next);
          if (!next) mutation.reset();
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{label}</AlertDialogTitle>
            <AlertDialogDescription role={mutation.isError ? "alert" : undefined}>
              {mutation.isError ? mutation.error.message : question}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={mutation.isPending}>Cancel</AlertDialogCancel>
            <Button
              variant="destructive"
              disabled={mutation.isPending}
              onClick={() => mutation.mutate()}
            >
              {mutation.isPending ? <Spinner /> : <Trash2 />}
              Delete
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

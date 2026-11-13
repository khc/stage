import { useMutation } from "@tanstack/react-query";
import { Loader2, Trash2 } from "lucide-react";
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

// A trash button that asks for confirmation before running `remove`.
export function ConfirmDelete({
  label,
  question,
  remove,
  onDeleted,
}: {
  label: string;
  question: string;
  remove: () => Promise<unknown>;
  onDeleted: () => void;
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
        variant="ghost"
        size="icon"
        aria-label={label}
        title={label}
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
              {mutation.isPending ? <Loader2 className="animate-spin" /> : <Trash2 />}
              Delete
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

import * as React from "react"
import { useAccountsQuery, useCreateAccountMutation, useUpdateAccountMutation, useDeleteAccountMutation, useSetAccountPolicyMutation, useRefreshAccountSourcesMutation } from "@/lib/queries"
import { DataTable, type DataTableColumn } from "@/components/DataTable"
import { ConfirmDialog } from "@/components/ConfirmDialog"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Field, FieldLabel } from "@/components/ui/field"
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog"
import { Select, SelectTrigger, SelectValue, SelectContent, SelectGroup, SelectItem } from "@/components/ui/select"
import { StatusBadge } from "@/components/StatusBadge"
import { Skeleton } from "@/components/ui/skeleton"
import { Trash, RefreshCw, Pencil } from "lucide-react"
import { RelativeTime } from "@/components/RelativeTime"
import type { CloudAccount, AccountPolicy } from "@/lib/types"

/** sourcesStatus is 'ok' | 'no_source_access' | 'error', or absent when never refreshed. */
function sourcesStatusValue(status: string | null | undefined): string {
  if (status === "ok") return "succeeded"
  if (status === "error") return "failed"
  if (status === "no_source_access") return "no_source_access"
  return "never_checked"
}

function AccountFormDialog({
  account,
  onClose,
  isOpen,
  onOpenChange
}: {
  account?: CloudAccount
  onClose: () => void
  isOpen: boolean
  onOpenChange: (open: boolean) => void
}) {
  const [label, setLabel] = React.useState(account?.label ?? "")
  const [apiKey, setApiKey] = React.useState("")
  const [concurrentLimit, setConcurrentLimit] = React.useState(account?.concurrentLimit?.toString() ?? "")
  const [dailyLimit, setDailyLimit] = React.useState(account?.dailyLimit?.toString() ?? "")

  React.useEffect(() => {
    if (isOpen) {
      setLabel(account?.label ?? "")
      setApiKey("")
      setConcurrentLimit(account?.concurrentLimit?.toString() ?? "")
      setDailyLimit(account?.dailyLimit?.toString() ?? "")
    }
  }, [isOpen, account])

  const createMut = useCreateAccountMutation()
  const updateMut = useUpdateAccountMutation()

  const isPending = createMut.isPending || updateMut.isPending

  const isValid = label.trim().length > 0 && (account ? true : apiKey.trim().length > 0)

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    if (!isValid) return

    const cLimit = concurrentLimit.trim() ? parseInt(concurrentLimit) : undefined
    const dLimit = dailyLimit.trim() ? parseInt(dailyLimit) : undefined

    if (account) {
      updateMut.mutate(
        { id: account.id, data: { label, concurrentLimit: cLimit, dailyLimit: dLimit } },
        { onSuccess: onClose }
      )
    } else {
      createMut.mutate(
        { label, apiKey, concurrentLimit: cLimit, dailyLimit: dLimit },
        { onSuccess: onClose }
      )
    }
  }

  return (
    <Dialog open={isOpen} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{account ? "Edit account" : "Add account"}</DialogTitle>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="flex flex-col gap-4">
          <Field>
            <FieldLabel htmlFor="account-label">Label</FieldLabel>
            <Input id="account-label" value={label} onChange={(e) => setLabel(e.target.value)} disabled={isPending} />
          </Field>
          {!account && (
            <Field>
              <FieldLabel htmlFor="account-key">API Key</FieldLabel>
              <Input id="account-key" type="password" value={apiKey} onChange={(e) => setApiKey(e.target.value)} disabled={isPending} />
            </Field>
          )}
          <Field>
            <FieldLabel htmlFor="account-concurrent">Concurrent Limit</FieldLabel>
            <Input id="account-concurrent" type="number" value={concurrentLimit} onChange={(e) => setConcurrentLimit(e.target.value)} disabled={isPending} placeholder="Unlimited" />
          </Field>
          <Field>
            <FieldLabel htmlFor="account-daily">Daily Limit</FieldLabel>
            <Input id="account-daily" type="number" value={dailyLimit} onChange={(e) => setDailyLimit(e.target.value)} disabled={isPending} placeholder="Unlimited" />
          </Field>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose} disabled={isPending}>Cancel</Button>
            <Button type="submit" disabled={!isValid || isPending}>{account ? "Save" : "Add"}</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

function AccountActions({ account }: { account: CloudAccount }) {
  const [isEditOpen, setIsEditOpen] = React.useState(false)
  const [isDeleteOpen, setIsDeleteOpen] = React.useState(false)
  const deleteMut = useDeleteAccountMutation()
  const refreshMut = useRefreshAccountSourcesMutation()

  return (
    <div className="flex gap-2 justify-end">
      <Button variant="ghost" size="icon" aria-label="Edit account" onClick={() => setIsEditOpen(true)}>
        <Pencil className="size-4" />
      </Button>
      <AccountFormDialog account={account} isOpen={isEditOpen} onOpenChange={setIsEditOpen} onClose={() => setIsEditOpen(false)} />

      <Button variant="ghost" size="icon" aria-label="Refresh sources" onClick={() => refreshMut.mutate(account.id)} disabled={refreshMut.isPending}>
        <RefreshCw className="size-4" />
      </Button>

      <Button variant="ghost" size="icon" aria-label="Delete account" className="text-destructive hover:bg-destructive/10 hover:text-destructive" onClick={() => setIsDeleteOpen(true)}>
        <Trash className="size-4" />
      </Button>

      <ConfirmDialog
        open={isDeleteOpen}
        onOpenChange={setIsDeleteOpen}
        title="Delete account"
        description={`Are you sure you want to delete ${account.label ?? account.id}?`}
        onConfirm={() => deleteMut.mutate(account.id)}
        confirmLabel="Delete"
        destructive={true}
      />
    </div>
  )
}


export function AccountsTab() {
  const { data, isLoading } = useAccountsQuery()
  const [isAddOpen, setIsAddOpen] = React.useState(false)
  const setPolicyMut = useSetAccountPolicyMutation()
  const updateMut = useUpdateAccountMutation()

  if (isLoading || !data) {
    return <Skeleton className="h-64 w-full" />
  }

  const columns: DataTableColumn<CloudAccount>[] = [
    {
      key: "label",
      header: "Label",
      cell: (row) => <div className="font-medium">{row.label ?? row.id}</div>,
    },
    {
      key: "key",
      header: "Key",
      cell: (row) => (
        <div className="font-mono text-muted-foreground">
          {row.keyPresent ? `••••${row.keyLast4 ?? ""}` : "No key"}
        </div>
      ),
    },
    {
      key: "enabled",
      header: "Enabled",
      cell: (row) => (
        <Button
          variant="outline"
          size="sm"
          onClick={() => updateMut.mutate({ id: row.id, data: { enabled: !row.enabled } })}
          disabled={updateMut.isPending}
        >
          {row.enabled ? "Enabled" : "Disabled"}
        </Button>
      ),
    },
    {
      key: "usage",
      header: "Usage (24h)",
      cell: (row) => (
        <div>
          {row.usage?.last24h ?? 0} / {row.dailyLimit}
        </div>
      ),
    },
    {
      key: "running",
      header: "Running",
      cell: (row) => (
        <div>
          {row.usage?.running ?? 0} / {row.concurrentLimit}
        </div>
      ),
    },
    {
      key: "sources",
      header: "Sources",
      cell: (row) => <StatusBadge kind="status" value={sourcesStatusValue(row.sourcesStatus)} />,
    },
    {
      key: "lastUsed",
      header: "Last Used",
      cell: (row) => row.lastUsedAt ? <RelativeTime iso={row.lastUsedAt} /> : <span className="text-muted-foreground">Never</span>,
    },
    {
      key: "actions",
      header: "",
      cell: (row) => <AccountActions account={row} />,
      className: "text-right"
    }
  ]

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-4">
          <Select
            value={data.policy}
            onValueChange={(v) => setPolicyMut.mutate(v as AccountPolicy)}
          >
            <SelectTrigger className="w-[180px]" id="policy-select">
              <SelectValue placeholder="Select policy" />
            </SelectTrigger>
            <SelectContent>
              <SelectGroup>
                <SelectItem value="round_robin">Round Robin</SelectItem>
                <SelectItem value="least_used">Least Used</SelectItem>
                <SelectItem value="priority">Priority</SelectItem>
              </SelectGroup>
            </SelectContent>
          </Select>
        </div>
        <Button onClick={() => setIsAddOpen(true)}>Add account</Button>
        <AccountFormDialog isOpen={isAddOpen} onOpenChange={setIsAddOpen} onClose={() => setIsAddOpen(false)} />
      </div>
      <DataTable columns={columns} rows={data.accounts} getRowId={(row) => row.id} />
    </div>
  )
}

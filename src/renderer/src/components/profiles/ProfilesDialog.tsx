import { useState } from 'react';
import {
  DndContext,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
} from '@dnd-kit/core';
import {
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable';
import { Check, GripVertical, Pencil, Play, Save, Trash, X } from 'lucide-react';

import type { Profile } from '@shared/types';
import {
  Badge,
  Button,
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Tooltip,
} from '@renderer/components/ui';
import { EmptyState } from '@renderer/components/common/EmptyState';
import { cn, formatDateTime } from '@renderer/lib/utils';

export interface ProfilesDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  profiles: Profile[];
  activeProfileId: string | null;
  busy: boolean;
  onApply: (id: string) => void;
  onRename: (id: string, name: string) => void;
  onDelete: (id: string) => void;
  onReorder: (activeId: string, overId: string) => void;
  onSaveCurrent: (name: string) => void;
}

export function ProfilesDialog({
  open,
  onOpenChange,
  profiles,
  activeProfileId,
  busy,
  onApply,
  onRename,
  onDelete,
  onReorder,
  onSaveCurrent,
}: ProfilesDialogProps) {
  const [newName, setNewName] = useState('');
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [confirmingId, setConfirmingId] = useState<string | null>(null);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  const handleDragEnd = (event: DragEndEvent): void => {
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    onReorder(String(active.id), String(over.id));
  };

  const saveCurrent = (): void => {
    onSaveCurrent(newName);
    setNewName('');
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="w-[min(40rem,calc(100vw-3rem))]">
        <DialogHeader>
          <DialogTitle>Perfis</DialogTitle>
          <DialogDescription>
            Um perfil guarda o que esta aplicado agora em todos os devices. Arraste para mudar a
            ordem da lista.
          </DialogDescription>
        </DialogHeader>

        <DialogBody className="flex flex-col gap-6">
          {profiles.length === 0 ? (
            <EmptyState
              icon={Save}
              title="Nenhum perfil salvo"
              description="Ajuste a iluminacao como voce gosta e salve aqui embaixo. Depois basta um clique para voltar a essa combinacao."
              className="py-8"
            />
          ) : (
            <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
              <SortableContext
                items={profiles.map((profile) => profile.id)}
                strategy={verticalListSortingStrategy}
              >
                <ul className="flex flex-col gap-2">
                  {profiles.map((profile) => (
                    <SortableProfileRow
                      key={profile.id}
                      profile={profile}
                      active={profile.id === activeProfileId}
                      busy={busy}
                      renaming={renamingId === profile.id}
                      confirming={confirmingId === profile.id}
                      onStartRename={() => setRenamingId(profile.id)}
                      onCancelRename={() => setRenamingId(null)}
                      onCommitRename={(name) => {
                        onRename(profile.id, name);
                        setRenamingId(null);
                      }}
                      onApply={() => onApply(profile.id)}
                      onAskDelete={() => setConfirmingId(profile.id)}
                      onCancelDelete={() => setConfirmingId(null)}
                      onConfirmDelete={() => {
                        onDelete(profile.id);
                        setConfirmingId(null);
                      }}
                    />
                  ))}
                </ul>
              </SortableContext>
            </DndContext>
          )}
        </DialogBody>

        <DialogFooter className="justify-between">
          <div className="flex flex-1 items-center gap-2">
            <label htmlFor="novo-perfil" className="sr-only">
              Nome do novo perfil
            </label>
            <input
              id="novo-perfil"
              value={newName}
              placeholder="Nome do perfil"
              maxLength={48}
              onChange={(event) => setNewName(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  event.preventDefault();
                  saveCurrent();
                }
              }}
              className={cn(
                'h-9 min-w-0 flex-1 rounded-md border border-input bg-surface-1 px-3 text-sm',
                'outline-none transition-colors placeholder:text-subtle-foreground hover:border-border-strong',
                'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring',
              )}
            />
          </div>

          <Button variant="primary" onClick={saveCurrent} disabled={busy}>
            <Save aria-hidden />
            Salvar perfil atual
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

interface SortableProfileRowProps {
  profile: Profile;
  active: boolean;
  busy: boolean;
  renaming: boolean;
  confirming: boolean;
  onStartRename: () => void;
  onCancelRename: () => void;
  onCommitRename: (name: string) => void;
  onApply: () => void;
  onAskDelete: () => void;
  onCancelDelete: () => void;
  onConfirmDelete: () => void;
}

function SortableProfileRow({
  profile,
  active,
  busy,
  renaming,
  confirming,
  onStartRename,
  onCancelRename,
  onCommitRename,
  onApply,
  onAskDelete,
  onCancelDelete,
  onConfirmDelete,
}: SortableProfileRowProps) {
  const {
    attributes,
    listeners,
    setNodeRef,
    setActivatorNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: profile.id });
  const [draft, setDraft] = useState(profile.name);

  return (
    <li
      ref={setNodeRef}
      style={{
        transform: transform ? `translate3d(${transform.x}px, ${transform.y}px, 0)` : undefined,
        transition: transition ?? undefined,
      }}
      className={cn(
        'flex items-center gap-2 rounded-lg border bg-card px-2 py-2.5 transition-colors',
        isDragging ? 'z-10 border-primary shadow-raised' : 'border-border',
        active && !isDragging && 'border-primary/50 bg-primary-soft/40',
      )}
    >
      <button
        type="button"
        ref={setActivatorNodeRef}
        aria-label={`Reordenar ${profile.name}`}
        className={cn(
          'shrink-0 cursor-grab rounded-sm p-1 text-subtle-foreground transition-colors',
          'outline-none hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-ring',
          'active:cursor-grabbing',
        )}
        {...attributes}
        {...listeners}
      >
        <GripVertical className="size-4" aria-hidden />
      </button>

      {renaming ? (
        <>
          <label htmlFor={`rename-${profile.id}`} className="sr-only">
            Novo nome para {profile.name}
          </label>
          <input
            id={`rename-${profile.id}`}
            autoFocus
            value={draft}
            maxLength={48}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault();
                onCommitRename(draft);
              } else if (event.key === 'Escape') {
                event.preventDefault();
                setDraft(profile.name);
                onCancelRename();
              }
            }}
            className={cn(
              'h-8 min-w-0 flex-1 rounded-md border border-input bg-surface-1 px-2.5 text-sm',
              'outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring',
            )}
          />
          <Button variant="ghost" size="icon-sm" aria-label="Confirmar nome" onClick={() => onCommitRename(draft)}>
            <Check />
          </Button>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="Cancelar"
            onClick={() => {
              setDraft(profile.name);
              onCancelRename();
            }}
          >
            <X />
          </Button>
        </>
      ) : (
        <>
          <div className="flex min-w-0 flex-1 flex-col gap-0.5">
            <span className="flex items-center gap-2">
              <span className="truncate text-sm font-medium text-foreground">{profile.name}</span>
              {active ? <Badge variant="primary">Em uso</Badge> : null}
            </span>
            <span className="text-[0.6875rem] text-subtle-foreground">
              {profile.entries.length === 0
                ? 'Sem ajustes guardados'
                : `${profile.entries.length} ${profile.entries.length === 1 ? 'ajuste' : 'ajustes'}`}
              {' - '}
              {formatDateTime(profile.updatedAt)}
            </span>
          </div>

          {confirming ? (
            <div className="flex shrink-0 items-center gap-2">
              <span className="text-xs text-muted-foreground">Apagar?</span>
              <Button variant="danger" size="sm" onClick={onConfirmDelete} disabled={busy}>
                Apagar
              </Button>
              <Button variant="ghost" size="sm" onClick={onCancelDelete}>
                Nao
              </Button>
            </div>
          ) : (
            <div className="flex shrink-0 items-center gap-1">
              <Tooltip content="Aplicar este perfil">
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label={`Aplicar ${profile.name}`}
                  onClick={onApply}
                  disabled={busy}
                >
                  <Play />
                </Button>
              </Tooltip>
              <Tooltip content="Renomear">
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label={`Renomear ${profile.name}`}
                  onClick={() => {
                    setDraft(profile.name);
                    onStartRename();
                  }}
                >
                  <Pencil />
                </Button>
              </Tooltip>
              <Tooltip content="Apagar">
                <Button
                  variant="danger-ghost"
                  size="icon-sm"
                  aria-label={`Apagar ${profile.name}`}
                  onClick={onAskDelete}
                >
                  <Trash />
                </Button>
              </Tooltip>
            </div>
          )}
        </>
      )}
    </li>
  );
}

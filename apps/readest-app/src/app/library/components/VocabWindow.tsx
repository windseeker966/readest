import React, { useEffect, useState } from 'react';
import { PiExport, PiTrash } from 'react-icons/pi';
import { useEnv } from '@/context/EnvContext';
import { useAppRouter } from '@/hooks/useAppRouter';
import { useTranslation } from '@/hooks/useTranslation';
import { eventDispatcher } from '@/utils/event';
import { navigateToReader } from '@/utils/nav';
import { ensureVocabLoaded, useVocabStore, vocabToJsonl } from '@/store/vocabStore';
import type { VocabEntry } from '@/types/vocab';
import Dialog from '@/components/Dialog';

export const setVocabDialogVisible = (visible: boolean) => {
  const dialog = document.getElementById('vocab_window');
  if (dialog) {
    dialog.dispatchEvent(new CustomEvent('setDialogVisibility', { detail: { visible } }));
  }
};

const exportFilename = () => {
  const stamp = new Date()
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/T(\d{6}).*/, '-$1');
  return `vocab-${stamp}.jsonl`;
};

/**
 * The vocabulary, newest first. A row opens the book at the word; the trash
 * icon forgets it (the highlight it made is cleared the next time the word is
 * removed from inside the book — there is no open view to clear it here).
 * Export writes LearningPack's import format, the same as SubWord's.
 */
export const VocabWindow: React.FC = () => {
  const _ = useTranslation();
  const router = useAppRouter();
  const { envConfig, appService } = useEnv();
  const entries = useVocabStore((s) => s.entries);
  const remove = useVocabStore((s) => s.remove);
  const [isOpen, setIsOpen] = useState(false);

  useEffect(() => {
    const handleCustomEvent = (event: CustomEvent) => {
      setIsOpen(event.detail.visible);
      if (event.detail.visible) ensureVocabLoaded(envConfig);
    };
    const el = document.getElementById('vocab_window');
    el?.addEventListener('setDialogVisibility', handleCustomEvent as EventListener);
    return () => {
      el?.removeEventListener('setDialogVisibility', handleCustomEvent as EventListener);
    };
  }, [envConfig]);

  const handleOpen = (entry: VocabEntry) => {
    if (!entry.bookHash) return;
    setIsOpen(false);
    navigateToReader(
      router,
      [entry.bookHash],
      entry.cfi ? `cfi=${encodeURIComponent(entry.cfi)}` : undefined,
    );
  };

  const handleExport = async () => {
    if (!appService || entries.length === 0) return;
    const saved = await appService.saveFile(exportFilename(), vocabToJsonl(entries), {
      mimeType: 'application/x-ndjson',
      share: appService.isMobile,
    });
    if (saved) {
      eventDispatcher.dispatch('toast', { message: _('Vocabulary exported'), type: 'success' });
    }
  };

  return (
    <Dialog
      id='vocab_window'
      isOpen={isOpen}
      title={_('Vocabulary')}
      onClose={() => setIsOpen(false)}
      snapHeight={appService?.isMobile ? 0.85 : undefined}
      boxClassName='sm:w-[520px]! sm:max-w-(--breakpoint-sm)! sm:h-[70vh]'
    >
      {isOpen && (
        <div className='flex flex-col gap-3 px-4 py-2'>
          <div className='flex items-center justify-between'>
            <span className='text-base-content/70 text-sm'>
              {_('{{count}} words', { count: entries.length })}
            </span>
            <button
              className='btn btn-ghost btn-sm gap-1'
              onClick={handleExport}
              disabled={entries.length === 0}
            >
              <PiExport className='h-4 w-4' />
              {_('Export')}
            </button>
          </div>
          {entries.length === 0 ? (
            <p className='text-base-content/60 py-8 text-center text-sm'>
              {_('Words you add from the translate popup will appear here.')}
            </p>
          ) : (
            <ul className='flex flex-col'>
              {entries.map((entry) => (
                <li
                  key={entry.id}
                  className='border-base-200 flex items-start gap-3 border-b py-3 last:border-b-0'
                >
                  <button
                    className='min-w-0 flex-1 text-start'
                    onClick={() => handleOpen(entry)}
                    disabled={!entry.bookHash}
                  >
                    <div className='flex items-baseline gap-2'>
                      <span className='text-base font-medium'>{entry.word}</span>
                      {entry.phonetic && (
                        <span className='text-base-content/60 text-sm'>{entry.phonetic}</span>
                      )}
                    </div>
                    {entry.meaning && <p className='text-sm'>{entry.meaning}</p>}
                    {entry.sentence && (
                      <p className='text-base-content/60 line-clamp-2 text-xs'>{entry.sentence}</p>
                    )}
                    <p className='text-base-content/50 mt-0.5 text-xs'>
                      {[entry.bookTitle, entry.createdAt.slice(0, 10)].filter(Boolean).join(' · ')}
                    </p>
                  </button>
                  <button
                    className='btn btn-ghost btn-sm btn-square shrink-0'
                    aria-label={_('Remove')}
                    onClick={() => remove(entry.id)}
                  >
                    <PiTrash className='h-4 w-4' />
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </Dialog>
  );
};

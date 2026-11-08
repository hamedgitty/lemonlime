import { createContext, useContext, useEffect, useState } from "react";
import { Dialog } from "@base-ui/react/dialog";
import { ImageOff, X } from "lucide-react";
import { IconButton } from "./ui.tsx";

/** Fetches a sent image from the thread's runner; resolves to a URL an `<img>` can show. */
export type LoadImage = (id: string) => Promise<string>;

/** Set by the thread view while it's connected; without it, images show as file names. */
export const ImageLoaderContext = createContext<LoadImage | null>(null);
export const useImageLoader = () => useContext(ImageLoaderContext);

/** Thumbnails of the images sent with a message; clicking one opens it larger. */
export function SentImages({ images }: { images: { id: string; name: string }[] }) {
  const load = useImageLoader();
  const [open, setOpen] = useState<{ src: string; name: string } | null>(null);
  if (!load) return null;
  return (
    <>
      <ul aria-label="Attached images" className="mt-2 flex flex-wrap gap-1.5">
        {images.map(img => (
          <li key={img.id}>
            <Thumb id={img.id} name={img.name} load={load} onOpen={src => setOpen({ src, name: img.name })} />
          </li>
        ))}
      </ul>
      <Dialog.Root open={open !== null} onOpenChange={o => !o && setOpen(null)}>
        <Dialog.Portal>
          <Dialog.Backdrop className="fixed inset-0 z-50 bg-ink/40 transition-opacity duration-200 data-[ending-style]:opacity-0 data-[starting-style]:opacity-0" />
          <Dialog.Popup className="fixed top-1/2 left-1/2 z-50 flex max-w-[calc(100vw-48px)] -translate-x-1/2 -translate-y-1/2 flex-col rounded-2xl border border-line bg-paper p-2 text-ink shadow-pop outline-none transition-[opacity,scale] duration-200 ease-(--ease-out) data-[ending-style]:scale-[0.99] data-[ending-style]:opacity-0 data-[ending-style]:duration-150 data-[starting-style]:scale-[0.96] data-[starting-style]:opacity-0">
            <Dialog.Title className="sr-only">{open?.name ?? "Image"}</Dialog.Title>
            {open && <img src={open.src} alt={open.name} className="max-h-[calc(100vh-120px)] max-w-full rounded-xl object-contain" />}
            <div className="flex items-center gap-2 pt-1.5 pl-2">
              <p className="min-w-0 flex-1 truncate text-[13px] text-ink-soft">{open?.name}</p>
              <Dialog.Close
                render={
                  <IconButton label="Close">
                    <X aria-hidden="true" className="size-4" />
                  </IconButton>
                }
              />
            </div>
          </Dialog.Popup>
        </Dialog.Portal>
      </Dialog.Root>
    </>
  );
}

function Thumb({ id, name, load, onOpen }: { id: string; name: string; load: LoadImage; onOpen: (src: string) => void }) {
  const [src, setSrc] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let live = true;
    load(id).then(
      url => live && setSrc(url),
      () => live && setFailed(true),
    );
    return () => {
      live = false;
    };
  }, [id, load]);
  if (failed)
    return (
      <span
        title={`${name} isn't available any more`}
        className="flex size-20 flex-col items-center justify-center gap-1 rounded-lg border border-line bg-paper/70 px-1.5 text-center text-[11.5px] text-ink-soft"
      >
        <ImageOff aria-hidden="true" className="size-4 text-ink-faint" />
        <span className="w-full truncate">{name}</span>
      </span>
    );
  return (
    <button
      type="button"
      disabled={!src}
      onClick={() => src && onOpen(src)}
      aria-label={`Open ${name}`}
      title={name}
      className="block size-20 overflow-hidden rounded-lg border border-[#e9d76a] bg-paper/70 outline-offset-2 hover:border-[#d9c445]"
    >
      {src && <img src={src} alt="" className="size-full object-cover" draggable={false} />}
    </button>
  );
}

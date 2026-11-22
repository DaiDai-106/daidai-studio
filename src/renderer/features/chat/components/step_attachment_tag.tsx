import { Icon } from "../../../shared/components/icon.tsx";

export function StepAttachmentTag({ name, onRemove }: { name: string; onRemove?: () => void }) {
  return (
    <span className="step-attachment" title={name}>
      <Icon name="file" size={15} />
      <span>{name}</span>
      {onRemove && (
        <button type="button" aria-label={`移除 STEP 附件 ${name}`} onClick={onRemove}>
          <Icon name="close" size={12} />
        </button>
      )}
    </span>
  );
}

import icon from "../../../resources/icons/app.svg?url";

export function BrandIcon({ size = 25 }: { size?: number }) {
  return (
    <img src={icon} alt="" width={size} height={size} className="brand-icon" aria-hidden="true" />
  );
}

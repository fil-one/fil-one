import { Description, Field } from '@headlessui/react';

import { Label } from './Label';

type FormFieldProps = {
  label: string;
  optional?: boolean;
  htmlFor?: string;
  description?: string;
  error?: string;
  className?: string;
  children: React.ReactNode;
};

/**
 * A labelled control with the sentence underneath it that explains or refuses
 * it.
 *
 * `Field` and `Description` rather than a plain `div` and `p`: the control
 * inside is a Headless UI input or select, and it reads the ids to put in its
 * own `aria-describedby` from that context. Passing the attribute down instead
 * does not work — Headless UI writes its own value over whatever a caller sets
 * — which left every validation message visible and unannounced.
 *
 * The error carries `role="alert"`, so a message that appears after a failed
 * submit is read out rather than waiting for the field to be visited again.
 */
export function FormField({
  label,
  optional,
  htmlFor,
  description,
  error,
  className,
  children,
}: FormFieldProps) {
  return (
    <Field className={`flex flex-col gap-2.5${className ? ` ${className}` : ''}`}>
      <Label htmlFor={htmlFor}>
        {label}
        {optional && (
          <span className="ml-1 text-xs font-normal text-(--color-paragraph-text-subtle)">
            (optional)
          </span>
        )}
      </Label>
      {children}
      {error ? (
        <Description role="alert" className="text-xs text-red-600">
          {error}
        </Description>
      ) : description ? (
        <Description className="text-xs text-zinc-600">{description}</Description>
      ) : null}
    </Field>
  );
}

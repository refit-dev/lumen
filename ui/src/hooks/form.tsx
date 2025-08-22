import { createFormHook, createFormHookContexts } from "@tanstack/react-form";
import { TextField } from "@/components/form/TextField";
import { SwitchField } from "@/components/form/SwitchField";
import { SubmitButton } from "@/components/form/SubmitButton";
import { SubmitButtonWithShortcut } from "@/components/form/SubmitButtonWithShortcut";
import { Dropdown } from "@/components/form/Dropdown";
import { NumberField } from "@/components/form/NumberField";
import { DatePicker } from "@/components/form/DatePicker";
import { Number2DecimalsField } from "@/components/form/Number2DecimalsField";

export const { fieldContext, useFieldContext, formContext, useFormContext } =
  createFormHookContexts();

export const { useAppForm, withForm } = createFormHook({
  fieldComponents: {
    TextField,
    SwitchField,
    Dropdown,
    NumberField,
    Number2DecimalsField,
    DatePicker,
  },
  formComponents: {
    SubmitButton,
    SubmitButtonWithShortcut,
  },
  fieldContext,
  formContext,
});

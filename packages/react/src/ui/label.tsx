import React from "react";
import styled from "styled-components";

interface LabelProps extends React.LabelHTMLAttributes<HTMLLabelElement> {
  // Add any custom props if needed
}

const StyledLabel = styled.label<LabelProps>`
  font-size: 14px; // text-sm
  font-weight: 500; // font-medium
  line-height: 1; // leading-none
  // The peer-disabled styles are harder to replicate directly without knowing the peer element structure
  // and without Tailwind's peer utility. For simplicity, we'll omit direct peer-disabled styling here.
  // If a disabled state is needed for the label itself, it can be added.
  // peer-disabled:cursor-not-allowed peer-disabled:opacity-70
`;

const Label = React.forwardRef<HTMLLabelElement, LabelProps>(
  ({ className, ...props }, ref) => {
    return <StyledLabel ref={ref} className={className} {...props} />;
  }
);

Label.displayName = "Label";

export { Label };

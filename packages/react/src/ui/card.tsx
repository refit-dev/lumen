import React from "react";
import styled from "styled-components";

// Base Card
const StyledCard = styled.div`
  background-color: #ffffff; // bg-card (assuming white for light mode)
  color: #09090b; // text-card-foreground (assuming default dark text)
  display: flex;
  flex-direction: column;
  position: relative; /* Added for absolute positioning of children like a close button */
  gap: 24px; // gap-6
  border-radius: 12px; // rounded-xl
  border: 1px solid #e5e7eb; // border
  padding-top: 24px; // py-6 (applied to top, bottom padding might be on footer/content or specific card usage)
  padding-bottom: 24px; // py-6 (applied to bottom)
  box-shadow:
    0 1px 3px 0 rgba(0, 0, 0, 0.1),
    0 1px 2px -1px rgba(0, 0, 0, 0.1); // shadow-sm
`;

const Card = React.forwardRef<
  HTMLDivElement,
  React.HTMLAttributes<HTMLDivElement>
>(({ className, ...props }, ref) => {
  return <StyledCard ref={ref} className={className} {...props} />;
});
Card.displayName = "Card";

// CardHeader
const StyledCardHeader = styled.div`
  /* @container/card-header (container queries are complex, simplifying) */
  display: grid;
  grid-auto-rows: min-content; /* auto-rows-min */
  grid-template-rows: auto auto; /* grid-rows-[auto_auto] */
  align-items: start;
  gap: 6px; // gap-1.5
  padding-left: 24px; // px-6
  padding-right: 24px; // px-6
  /* has-data-[slot=card-action]:grid-cols-[1fr_auto] (complex selector, needs JS or specific structure) */
  /* [.border-b]:pb-6 (conditional padding, apply if a border-b class is used on a child or manually) */
`;

const CardHeader = React.forwardRef<
  HTMLDivElement,
  React.HTMLAttributes<HTMLDivElement>
>(({ className, ...props }, ref) => {
  return <StyledCardHeader ref={ref} className={className} {...props} />;
});
CardHeader.displayName = "CardHeader";

// CardTitle
const StyledCardTitle = styled.div`
  line-height: 1; // leading-none
  font-weight: 600; // font-semibold
  /* Assuming font size will be inherited or set by usage (e.g., h2, h3) */
`;

const CardTitle = React.forwardRef<
  HTMLDivElement,
  React.HTMLAttributes<HTMLDivElement>
>(({ className, ...props }, ref) => {
  return <StyledCardTitle ref={ref} className={className} {...props} />;
});
CardTitle.displayName = "CardTitle";

// CardDescription
const StyledCardDescription = styled.div`
  color: #71717a; // text-muted-foreground
  font-size: 14px; // text-sm
`;

const CardDescription = React.forwardRef<
  HTMLDivElement,
  React.HTMLAttributes<HTMLDivElement>
>(({ className, ...props }, ref) => {
  return <StyledCardDescription ref={ref} className={className} {...props} />;
});
CardDescription.displayName = "CardDescription";

// CardAction
const StyledCardAction = styled.div`
  /* col-start-2 row-span-2 row-start-1 (grid specific, depends on CardHeader's grid setup) */
  /* For simplicity, assuming it will be placed correctly by flex/grid in parent */
  align-self: start; // self-start
  justify-self: end; // justify-self-end
`;

const CardAction = React.forwardRef<
  HTMLDivElement,
  React.HTMLAttributes<HTMLDivElement>
>(({ className, ...props }, ref) => {
  return <StyledCardAction ref={ref} className={className} {...props} />;
});
CardAction.displayName = "CardAction";

// CardContent
const StyledCardContent = styled.div`
  padding-left: 24px; // px-6
  padding-right: 24px; // px-6
  /* py will depend on context, often Card itself has py or content has its own internal padding */
`;

const CardContent = React.forwardRef<
  HTMLDivElement,
  React.HTMLAttributes<HTMLDivElement>
>(({ className, ...props }, ref) => {
  return <StyledCardContent ref={ref} className={className} {...props} />;
});
CardContent.displayName = "CardContent";

// CardFooter
const StyledCardFooter = styled.div`
  display: flex;
  align-items: center;
  padding-left: 24px; // px-6
  padding-right: 24px; // px-6
  /* [.border-t]:pt-6 (conditional padding, apply if a border-t class is used on a child or manually) */
`;

const CardFooter = React.forwardRef<
  HTMLDivElement,
  React.HTMLAttributes<HTMLDivElement>
>(({ className, ...props }, ref) => {
  return <StyledCardFooter ref={ref} className={className} {...props} />;
});
CardFooter.displayName = "CardFooter";

export {
  Card,
  CardHeader,
  CardFooter,
  CardTitle,
  CardAction,
  CardDescription,
  CardContent,
};

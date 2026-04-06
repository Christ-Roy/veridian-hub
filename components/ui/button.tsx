import * as React from "react"
import { Slot } from "@radix-ui/react-slot"
import { cva, type VariantProps } from "class-variance-authority"

import { cn } from "@/lib/utils"
import { trackButtonClick } from "@/lib/gtm"

const buttonVariants = cva(
  "inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md text-sm font-medium ring-offset-background transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0",
  {
    variants: {
      variant: {
        default: "bg-primary text-primary-foreground hover:bg-primary/90",
        destructive:
          "bg-destructive text-destructive-foreground hover:bg-destructive/90",
        outline:
          "border border-input bg-background hover:bg-accent hover:text-accent-foreground",
        secondary:
          "bg-secondary text-secondary-foreground hover:bg-secondary/80",
        ghost: "hover:bg-accent hover:text-accent-foreground",
        link: "text-primary underline-offset-4 hover:underline",
        slim: "bg-primary text-primary-foreground hover:bg-primary/90",
      },
      size: {
        default: "h-10 px-4 py-2",
        sm: "h-9 rounded-md px-3",
        lg: "h-11 rounded-md px-8",
        icon: "h-10 w-10",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  }
)

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {
  asChild?: boolean
  loading?: boolean
  track?: boolean // Enable/disable tracking (default: true)
  trackLabel?: string // Custom label for tracking (default: button text)
}

const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, asChild = false, loading, disabled, children, track = true, trackLabel, onClick, ...props }, ref) => {
    const Comp = asChild ? Slot : "button"

    // Extract button text for tracking
    const getButtonText = (): string => {
      if (trackLabel) return trackLabel
      if (typeof children === 'string') return children
      if (Array.isArray(children)) {
        return children
          .filter((child): child is string => typeof child === 'string')
          .join(' ')
      }
      return 'Button'
    }

    // Wrap onClick with tracking
    const handleClick = (e: React.MouseEvent<HTMLButtonElement>) => {
      // Track button click if enabled and button is not disabled
      if (track && !disabled && !loading && typeof window !== 'undefined') {
        const buttonText = getButtonText()
        const location = window.location.pathname
        trackButtonClick(buttonText, location, variant || undefined)
      }

      // Call original onClick if provided
      if (onClick) {
        onClick(e)
      }
    }

    // When asChild is true, we can't add loading spinner as it would create multiple children
    const content = asChild ? children : (
      <>
        {loading && (
          <svg
            className="animate-spin h-4 w-4 mr-2"
            xmlns="http://www.w3.org/2000/svg"
            fill="none"
            viewBox="0 0 24 24"
          >
            <circle
              className="opacity-25"
              cx="12"
              cy="12"
              r="10"
              stroke="currentColor"
              strokeWidth="4"
            />
            <path
              className="opacity-75"
              fill="currentColor"
              d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
            />
          </svg>
        )}
        {children}
      </>
    )

    return (
      <Comp
        className={cn(buttonVariants({ variant, size, className }))}
        ref={ref}
        disabled={disabled || loading}
        // Ne pas attacher onClick avec tracking quand asChild (pour Server Components)
        onClick={!asChild ? handleClick : onClick}
        {...props}
      >
        {content}
      </Comp>
    )
  }
)
Button.displayName = "Button"

export { Button, buttonVariants }

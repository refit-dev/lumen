"use client";

import { useState, useCallback } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import {
  submitContactForm,
  submitAuthenticatedContactForm,
} from "@/lib/actions/contact";
import { toast } from "sonner";
import { useSession } from "@/lib/auth-client";
import {
  GoogleReCaptchaProvider,
  useGoogleReCaptcha,
} from "react-google-recaptcha-v3";

interface ContactUsModalProps {
  children: React.ReactNode;
}

interface AuthenticatedContactModalProps {
  children: React.ReactNode;
  context?: string;
}

function ContactFormContent({ children }: ContactUsModalProps) {
  const [open, setOpen] = useState(false);
  const [email, setEmail] = useState("");
  const [message, setMessage] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const { executeRecaptcha } = useGoogleReCaptcha();

  const handleSubmit = useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault();

      if (!email || !message) {
        toast.error("Please fill in all fields");
        return;
      }

      if (!executeRecaptcha) {
        toast.error("reCAPTCHA not ready. Please try again.");
        return;
      }

      setIsSubmitting(true);

      try {
        // Get reCAPTCHA token
        const recaptchaToken = await executeRecaptcha("contact_form");

        await submitContactForm({ email, message, recaptchaToken });
        toast.success("Thank you! Your message has been sent successfully.");
        setEmail("");
        setMessage("");
        setOpen(false);
      } catch (error) {
        console.error("Contact form submission error:", error);
        toast.error("Failed to send message. Please try again.");
      } finally {
        setIsSubmitting(false);
      }
    },
    [email, message, executeRecaptcha]
  );

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>{children}</DialogTrigger>
      <DialogContent className="sm:max-w-[425px]">
        <DialogHeader>
          <DialogTitle>Message Us</DialogTitle>
          <DialogDescription>
            Send us a message and we&apos;ll get back to you ASAP!
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="email">Email</Label>
            <Input
              id="email"
              type="email"
              placeholder="your@email.com"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="message">Message</Label>
            <Textarea
              id="message"
              placeholder="Tell us how we can help you..."
              className="min-h-[100px]"
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              required
            />
          </div>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => setOpen(false)}
            >
              Cancel
            </Button>
            <Button
              type="submit"
              disabled={isSubmitting}
              className="bg-gray-900 hover:bg-gray-800"
            >
              {isSubmitting ? "Sending..." : "Send Message"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export function ContactUsModal({ children }: ContactUsModalProps) {
  return (
    <GoogleReCaptchaProvider
      reCaptchaKey={process.env.NEXT_PUBLIC_GOOGLE_RECAPTCHA_SITE_KEY!}
      scriptProps={{
        async: false,
        defer: false,
        appendTo: "head",
        nonce: undefined,
      }}
    >
      <ContactFormContent>{children}</ContactFormContent>
    </GoogleReCaptchaProvider>
  );
}

export function AuthenticatedContactModal({
  children,
  context,
}: AuthenticatedContactModalProps) {
  const [open, setOpen] = useState(false);
  const [message, setMessage] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const { data: session } = useSession();

  const handleSubmit = useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault();

      if (!message) {
        toast.error("Please enter a message");
        return;
      }

      if (!session?.user?.email) {
        toast.error("User email not found. Please try refreshing the page.");
        return;
      }

      setIsSubmitting(true);

      try {
        await submitAuthenticatedContactForm({
          message,
          userEmail: session.user.email,
          context,
        });
        toast.success("Thank you! Your message has been sent successfully.");
        setMessage("");
        setOpen(false);
      } catch (error) {
        console.error("Contact form submission error:", error);
        toast.error("Failed to send message. Please try again.");
      } finally {
        setIsSubmitting(false);
      }
    },
    [message, session?.user?.email, context]
  );

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>{children}</DialogTrigger>
      <DialogContent className="sm:max-w-[425px]">
        <DialogHeader>
          <DialogTitle>Contact Us</DialogTitle>
          <DialogDescription>
            {context === "external-tax-providers"
              ? "Tell us about your external tax provider needs and we'll get back to you right away!"
              : "Send us a message and we'll get back to you ASAP!"}
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="user-email" className="text-sm text-gray-600">
              Your email: {session?.user?.email}
            </Label>
          </div>
          <div className="space-y-2">
            <Label htmlFor="message">Message</Label>
            <Textarea
              id="message"
              placeholder={
                context === "external-tax-providers"
                  ? "Tell us about your tax calculation requirements, which tax providers you'd like to integrate with (TaxJar, Avalara, etc.), and any specific features you need..."
                  : "Tell us how we can help you..."
              }
              className="min-h-[100px]"
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              required
            />
          </div>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => setOpen(false)}
            >
              Cancel
            </Button>
            <Button
              type="submit"
              disabled={isSubmitting}
              className="bg-gray-900 hover:bg-gray-800"
            >
              {isSubmitting ? "Sending..." : "Send Message"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

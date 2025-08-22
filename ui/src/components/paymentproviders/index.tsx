import Image from "next/image";
import { useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";

export const PaymentProviders = ({
  onStripeClick,
  onDodoClick,
  onBetaRequestClick,
}: {
  onStripeClick: () => void;
  onDodoClick: () => void;
  onBetaRequestClick: (providerName: string) => Promise<void>;
}) => {
  // Add beta access modal state
  const [betaModalOpen, setBetaModalOpen] = useState(false);
  const [betaProvider, setBetaProvider] = useState<string>("");
  const [betaAccessRequested, setBetaAccessRequested] = useState(false);

  const handleBetaProviderClick = (providerName: string) => {
    setBetaProvider(providerName);
    setBetaModalOpen(true);
    setBetaAccessRequested(false);
  };

  const handleBetaAccessRequest = () => {
    onBetaRequestClick(betaProvider);
    setBetaAccessRequested(true);
  };

  const handleModalClose = () => {
    setBetaModalOpen(false);
    setBetaProvider("");
    setBetaAccessRequested(false);
  };

  return (
    <>
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
        {/* Stripe Option */}
        <div
          onClick={onStripeClick}
          className="cursor-pointer group relative overflow-hidden rounded-lg border-2 border-gray-200 hover:border-blue-500 transition-all duration-200 p-4 bg-gradient-to-br from-blue-50 to-indigo-50 hover:from-blue-100 hover:to-indigo-100"
        >
          <div className="flex flex-col items-center space-y-3">
            <div className="bg-white rounded-lg shadow-md flex items-center justify-center p-2">
              <Image
                src="/stripe.png"
                alt="Stripe"
                width={100}
                height={32}
                className="w-full h-8 object-contain"
              />
            </div>
            <div className="text-center">
              <p className="text-xs text-gray-600">
                Available in most countries
              </p>
            </div>
          </div>
          <div className="absolute inset-0 bg-blue-500 opacity-0 group-hover:opacity-5 transition-opacity duration-200"></div>
        </div>

        {/* Dodo Payments Option */}
        <div
          onClick={onDodoClick}
          className="cursor-pointer group relative overflow-hidden rounded-lg border-2 border-gray-200 hover:border-green-500 transition-all duration-200 p-4 bg-gradient-to-br from-green-50 to-lime-50 hover:from-green-100 hover:to-lime-100"
        >
          <div className="flex flex-col items-center space-y-3">
            <div className="bg-black rounded-lg shadow-md flex items-center justify-center p-2">
              <Image
                src="/dodopayments.svg"
                alt="Dodo Payments"
                width={100}
                height={32}
                className="w-full h-8 object-contain"
              />
            </div>
            <div className="text-center">
              <p className="text-xs text-gray-600">
                Merchant of Record (popular in India)
              </p>
            </div>
          </div>
          <div className="absolute inset-0 bg-green-500 opacity-0 group-hover:opacity-5 transition-opacity duration-200"></div>
        </div>

        {/* Paddle Option (Beta) */}
        <div
          onClick={() => handleBetaProviderClick("Paddle")}
          className="cursor-pointer group relative overflow-hidden rounded-lg border-2 border-gray-200 hover:border-purple-500 transition-all duration-200 p-4 bg-gradient-to-br from-purple-50 to-pink-50 hover:from-purple-100 hover:to-pink-100"
        >
          <div className="flex flex-col items-center space-y-3">
            <div className="bg-white rounded-lg shadow-md flex items-center justify-center p-2">
              <Image
                src="/paddle.jpg"
                alt="Paddle"
                width={100}
                height={32}
                className="w-full h-8 object-contain"
              />
            </div>
            <div className="text-center">
              <p className="text-xs text-gray-600">Merchant of Record</p>
            </div>
          </div>
          <div className="absolute inset-0 bg-purple-500 opacity-0 group-hover:opacity-5 transition-opacity duration-200"></div>
        </div>

        {/* Checkout.com Option (Beta) */}
        <div
          onClick={() => handleBetaProviderClick("Checkout.com")}
          className="cursor-pointer group relative overflow-hidden rounded-lg border-2 border-gray-200 hover:border-indigo-500 transition-all duration-200 p-4 bg-gradient-to-br from-indigo-50 to-blue-50 hover:from-indigo-100 hover:to-blue-100"
        >
          <div className="flex flex-col items-center space-y-3">
            <div className="bg-white rounded-lg shadow-md flex items-center justify-center p-2">
              <Image
                src="/checkoutdotcom.png"
                alt="Checkout.com"
                width={100}
                height={32}
                className="w-full h-8 object-contain"
              />
            </div>
            <div className="text-center">
              <p className="text-xs text-gray-600">Global payments platform</p>
            </div>
          </div>
          <div className="absolute inset-0 bg-indigo-500 opacity-0 group-hover:opacity-5 transition-opacity duration-200"></div>
        </div>

        {/* Razorpay Option (Beta) */}
        <div
          onClick={() => handleBetaProviderClick("Razorpay")}
          className="cursor-pointer group relative overflow-hidden rounded-lg border-2 border-gray-200 hover:border-blue-600 transition-all duration-200 p-4 bg-gradient-to-br from-blue-50 to-indigo-50 hover:from-blue-100 hover:to-indigo-100"
        >
          <div className="flex flex-col items-center space-y-3">
            <div className="bg-white rounded-lg shadow-md flex items-center justify-center p-2">
              <Image
                src="/razorpay.svg"
                alt="Razorpay"
                width={100}
                height={32}
                className="w-full h-8 object-contain"
              />
            </div>
            <div className="text-center">
              <p className="text-xs text-gray-600">Popular in India</p>
            </div>
          </div>
          <div className="absolute inset-0 bg-blue-600 opacity-0 group-hover:opacity-5 transition-opacity duration-200"></div>
        </div>

        {/* Adyen Option (Beta) */}
        <div
          onClick={() => handleBetaProviderClick("Adyen")}
          className="cursor-pointer group relative overflow-hidden rounded-lg border-2 border-gray-200 hover:border-teal-500 transition-all duration-200 p-4 bg-gradient-to-br from-teal-50 to-cyan-50 hover:from-teal-100 hover:to-cyan-100"
        >
          <div className="flex flex-col items-center space-y-3">
            <div className="bg-white rounded-lg shadow-md flex items-center justify-center p-2">
              <Image
                src="/adyen.png"
                alt="Adyen"
                width={100}
                height={32}
                className="w-full h-8 object-contain"
              />
            </div>
            <div className="text-center">
              <p className="text-xs text-gray-600">Enterprise payments</p>
            </div>
          </div>
          <div className="absolute inset-0 bg-teal-500 opacity-0 group-hover:opacity-5 transition-opacity duration-200"></div>
        </div>
      </div>

      {/* Beta Access Request Modal */}
      <Dialog open={betaModalOpen} onOpenChange={handleModalClose}>
        <DialogContent className="sm:max-w-[425px]">
          <DialogHeader>
            <DialogTitle>{betaProvider} is currently in beta</DialogTitle>
          </DialogHeader>
          {!betaAccessRequested ? (
            <>
              <DialogDescription>
                {betaProvider} is currently in beta. Do you want to request
                access?
              </DialogDescription>
              <DialogFooter>
                <Button variant="outline" onClick={handleModalClose}>
                  Cancel
                </Button>
                <Button onClick={handleBetaAccessRequest}>
                  Yes, request access
                </Button>
              </DialogFooter>
            </>
          ) : (
            <>
              <DialogDescription>
                We&apos;ll be in touch shortly
              </DialogDescription>
              <DialogFooter>
                <Button onClick={handleModalClose}>Close</Button>
              </DialogFooter>
            </>
          )}
        </DialogContent>
      </Dialog>
    </>
  );
};

import { Metadata } from "next";

export const metadata: Metadata = {
  title: "Impressum - Lumen",
  description:
    "Legal information and company details for Lumen billing platform",
};

export default function ImpressumPage() {
  return (
    <div className="max-w-4xl mx-auto px-6 py-16">
      <div className="prose prose-gray max-w-none">
        <h1 className="text-3xl font-bold text-gray-900 mb-8">Impressum</h1>

        <p className="text-gray-600 mb-8">
          Legal information according to § 5 TMG (German Telemedia Act)
        </p>

        <div className="space-y-8">
          <section>
            <h2 className="text-2xl font-semibold text-gray-900 mb-4">
              Company Information
            </h2>
            <div className="bg-gray-50 p-6 rounded-lg">
              <div className="grid md:grid-cols-2 gap-6">
                <div>
                  <h3 className="text-lg font-medium text-gray-900 mb-3">
                    Legal Entity
                  </h3>
                  <p className="text-gray-700 leading-relaxed">
                    <strong>Company:</strong> Pretzel AI GmbH
                    <br />
                    <strong>Legal Form:</strong> Limited Liability Company
                    (GmbH)
                    <br />
                    <strong>Registration:</strong> Commercial Register
                    <br />
                    <strong>Register Number:</strong> HRB 260412 B<br />
                    <strong>Registration Court:</strong> Amtsgericht
                    Charlottenburg
                  </p>
                </div>
                <div>
                  <h3 className="text-lg font-medium text-gray-900 mb-3">
                    Tax Information
                  </h3>
                  <p className="text-gray-700 leading-relaxed">
                    <strong>VAT ID:</strong> DE366513651
                  </p>
                </div>
              </div>
            </div>
          </section>

          <section>
            <h2 className="text-2xl font-semibold text-gray-900 mb-4">
              Business Address
            </h2>
            <div className="bg-gray-50 p-6 rounded-lg">
              <p className="text-gray-700 leading-relaxed">
                <strong>Pretzel AI GmbH</strong>
                <br />
                c/o Prasoon Shukla
                <br />
                Jungstraße 12
                <br />
                10247 Berlin
                <br />
                Germany
              </p>
            </div>
          </section>

          <section>
            <h2 className="text-2xl font-semibold text-gray-900 mb-4">
              Management
            </h2>
            <div className="bg-gray-50 p-6 rounded-lg">
              <p className="text-gray-700 leading-relaxed">
                <strong>Managing Directors (Geschäftsführer):</strong>
                <br />
                Prasoon Shukla
                <br />
                Ramon Garate Funcia
              </p>
            </div>
          </section>

          <section>
            <h2 className="text-2xl font-semibold text-gray-900 mb-4">
              Contact Information
            </h2>
            <div className="bg-gray-50 p-6 rounded-lg">
              <p className="text-gray-700 leading-relaxed">
                <strong>Email:</strong>{" "}
                <a
                  href="mailto:help@getlumen.dev"
                  className="text-blue-600 hover:text-blue-800 underline"
                >
                  help@getlumen.dev
                </a>
                <br />
                <strong>Website:</strong>{" "}
                <a
                  href="https://getlumen.dev"
                  className="text-blue-600 hover:text-blue-800 underline"
                >
                  getlumen.dev
                </a>
              </p>
            </div>
          </section>

          <section>
            <h2 className="text-2xl font-semibold text-gray-900 mb-4">
              Dispute Resolution
            </h2>
            <div className="bg-gray-50 p-6 rounded-lg">
              <p className="text-gray-700 leading-relaxed">
                We are not willing or obliged to participate in dispute
                resolution proceedings before a consumer arbitration board.
              </p>
            </div>
          </section>

          <section>
            <h2 className="text-2xl font-semibold text-gray-900 mb-4">
              Liability Notice
            </h2>
            <div className="space-y-4">
              <div>
                <h3 className="text-lg font-medium text-gray-900 mb-2">
                  Content Liability
                </h3>
                <p className="text-gray-700 leading-relaxed">
                  We make every effort to keep the information on our website
                  current, but accept no liability for the content provided.
                  Pursuant to § 7 para. 1 TMG, we are liable for our own content
                  on these pages in accordance with general laws.
                </p>
              </div>

              <div>
                <h3 className="text-lg font-medium text-gray-900 mb-2">
                  Link Liability
                </h3>
                <p className="text-gray-700 leading-relaxed">
                  Our website contains links to external websites. We have no
                  influence over the content of these websites and accept no
                  liability for their content. The content of linked websites is
                  the sole responsibility of their operators.
                </p>
              </div>

              <div>
                <h3 className="text-lg font-medium text-gray-900 mb-2">
                  Copyright
                </h3>
                <p className="text-gray-700 leading-relaxed">
                  The content and works on these pages are subject to German
                  copyright law. Reproduction, editing, distribution, and any
                  kind of exploitation outside the limits of copyright require
                  written consent from the author or creator.
                </p>
              </div>
            </div>
          </section>

          <section className="border-t border-gray-200 pt-8">
            <p className="text-sm text-gray-500">
              This Impressum is subject to German law. Last updated: July 30,
              2025
            </p>
          </section>
        </div>
      </div>
    </div>
  );
}

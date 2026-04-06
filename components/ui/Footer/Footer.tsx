import Link from 'next/link';

import Logo from '@/components/icons/Logo';

// Composant PaymentIcons - Logos de cartes de paiement
function PaymentIcons() {
  return (
    <div className="flex items-center space-x-3" aria-label="Moyens de paiement acceptés">
      {/* Visa */}
      <svg
        className="h-6 w-auto"
        viewBox="0 0 48 32"
        fill="none"
        xmlns="http://www.w3.org/2000/svg"
        aria-label="Visa"
      >
        <rect width="48" height="32" rx="4" fill="#1A1F71"/>
        <path
          d="M19.5 21H17L18.5 11H21L19.5 21ZM15 11L12.5 18L12.2 16.5L11.3 12C11.3 12 11.2 11 10 11H6L6 11.2C6 11.2 7.5 11.5 9.2 12.5L11.5 21H14.2L18 11H15ZM32 21H34.5L32.5 11H30.5C29.5 11 29.2 11.5 29 12L25 21H27.7L28.2 19.5H31.5L32 21ZM29 17.5L30.2 14L30.8 17.5H29ZM26.5 14.2L27 12C27 12 25.8 11.5 24.5 11.5C23 11.5 20 12.2 20 14.5C20 16.5 22.8 16.5 22.8 17.5C22.8 18.5 20.2 18.2 19 17.5L18.5 19.5C18.5 19.5 19.8 20 21.5 20C23.2 20 26 19.2 26 17C26 15 23.2 14.8 23.2 14C23.2 13.2 25.2 13.2 26.5 14.2Z"
          fill="white"
        />
      </svg>

      {/* Mastercard */}
      <svg
        className="h-6 w-auto"
        viewBox="0 0 48 32"
        fill="none"
        xmlns="http://www.w3.org/2000/svg"
        aria-label="Mastercard"
      >
        <rect width="48" height="32" rx="4" fill="#000"/>
        <circle cx="18" cy="16" r="8" fill="#EB001B"/>
        <circle cx="30" cy="16" r="8" fill="#F79E1B"/>
        <path
          d="M24 10.5C25.8 12 27 14.3 27 16.8C27 19.3 25.8 21.6 24 23.1C22.2 21.6 21 19.3 21 16.8C21 14.3 22.2 12 24 10.5Z"
          fill="#FF5F00"
        />
      </svg>

      {/* American Express */}
      <svg
        className="h-6 w-auto"
        viewBox="0 0 48 32"
        fill="none"
        xmlns="http://www.w3.org/2000/svg"
        aria-label="American Express"
      >
        <rect width="48" height="32" rx="4" fill="#006FCF"/>
        <path
          d="M8 16L10 12H13L14 14L15 12H18V20H15L14 18L13 20H10V18L8 20H6V12H8L8 16ZM10 13.5V18.5H11L13 15.5V18.5H15V13.5H13L11 16.5V13.5H10ZM16 13.5V18.5H18V16.5H19L20 18.5H22L20.5 16L22 13.5H20L19 15.5H18V13.5H16ZM23 13.5H28V14.5H25V15.5H27.5V16.5H25V17.5H28V18.5H23V13.5ZM29 13.5H32C33 13.5 33.5 14 33.5 14.8C33.5 15.5 33 16 32.5 16.2C33.2 16.3 33.8 16.8 33.8 17.5C33.8 18.5 33 18.5 32.2 18.5H29V13.5ZM30.5 14.5V15.8H31.8C32.2 15.8 32.3 15.6 32.3 15.3C32.3 15 32.2 14.8 31.8 14.8H30.5V14.5ZM30.5 16.5V17.5H32C32.5 17.5 32.6 17.3 32.6 17C32.6 16.7 32.4 16.5 32 16.5H30.5ZM35 13.5H36.5V16H38.8V13.5H40.3V18.5H38.8V16.8H36.5V18.5H35V13.5Z"
          fill="white"
        />
      </svg>
    </div>
  );
}

export default function Footer() {
  return (
    <footer className="footer">
      <div className="footer-container">
        <div className="col-span-1 lg:col-span-2">
          <Link
            href="/"
            className="flex items-center flex-initial font-bold md:mr-24"
          >
            <span className="mr-2 border rounded-full border-border">
              <Logo />
            </span>
            <span>Veridian</span>
          </Link>
        </div>
        <div className="col-span-1 lg:col-span-2">
          <ul className="flex flex-col flex-initial md:flex-1">
            <li className="py-3 md:py-0 md:pb-4">
              <Link
                href="/"
                className="text-foreground transition duration-150 ease-in-out hover:text-muted-foreground"
              >
                Home
              </Link>
            </li>
            <li className="py-3 md:py-0 md:pb-4">
              <Link
                href="/"
                className="text-foreground transition duration-150 ease-in-out hover:text-muted-foreground"
              >
                About
              </Link>
            </li>
            <li className="py-3 md:py-0 md:pb-4">
              <Link
                href="/"
                className="text-foreground transition duration-150 ease-in-out hover:text-muted-foreground"
              >
                Careers
              </Link>
            </li>
            <li className="py-3 md:py-0 md:pb-4">
              <Link
                href="/"
                className="text-foreground transition duration-150 ease-in-out hover:text-muted-foreground"
              >
                Blog
              </Link>
            </li>
          </ul>
        </div>
        <div className="col-span-1 lg:col-span-2">
          <ul className="flex flex-col flex-initial md:flex-1">
            <li className="py-3 md:py-0 md:pb-4">
              <p className="font-bold text-foreground transition duration-150 ease-in-out hover:text-muted-foreground">
                LEGAL
              </p>
            </li>
            <li className="py-3 md:py-0 md:pb-4">
              <Link
                href="/legal#confidentialite"
                className="text-foreground transition duration-150 ease-in-out hover:text-muted-foreground"
              >
                Privacy Policy
              </Link>
            </li>
            <li className="py-3 md:py-0 md:pb-4">
              <Link
                href="/legal#cgv"
                className="text-foreground transition duration-150 ease-in-out hover:text-muted-foreground"
              >
                Terms of Use
              </Link>
            </li>
          </ul>
        </div>
      </div>
      <div className="flex flex-col items-center justify-center py-12 space-y-4 md:flex-row bg-card">
        <div className="flex flex-col items-center space-y-2">
          <span>
            &copy; {new Date().getFullYear()} Veridian. Tous droits réservés.
          </span>
          <span className="text-sm text-muted-foreground">Moyens de paiement sécurisés</span>
          <PaymentIcons />
        </div>
      </div>
    </footer>
  );
}

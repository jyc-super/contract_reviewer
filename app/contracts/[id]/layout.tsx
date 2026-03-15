import { ContractTabNav } from "../../../components/contract/ContractTabNav";

interface ContractLayoutProps {
  children: React.ReactNode;
  params: Promise<{ id: string }>;
}

export default async function ContractLayout({ children, params }: ContractLayoutProps) {
  const { id } = await params;

  return (
    <div>
      <ContractTabNav contractId={id} />
      {children}
    </div>
  );
}
